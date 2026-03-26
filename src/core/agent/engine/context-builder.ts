/**
 * ContextBuilder - 构建上下文窗口（截断/压缩/注入）
 * V5.3 - 保鲜区 + 压缩区模型，增量分段压缩，图片分析缓存替换
 *        JSONL 中只存 ![image](imageKey)，运行时按 sessionId 解析完整磁盘路径
 */

import { ConversationStore, type ConversationEntry, type CompressedSummary, type ImageAnalysisCache } from '../../memory/conversation-store.js'
import { SystemPromptBuilder } from './system-prompt-builder.js'
import { MEMORY_CONFIG, estimateTokens, COMPRESS_SYSTEM_PROMPT } from '../../memory/config.js'
import { getFilesDir } from '../../../utils/paths.js'
import { existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'

// ==================== 类型定义 ====================

export interface MessageParam {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ContextBuildResult {
  systemPrompt: string
  messages: MessageParam[]
  stats: {
    systemPromptTokens: number
    summaryTokens: number
    recentTokens: number
    totalTokens: number
    totalRounds: number
    recentRounds: number
    compressedRounds: number
    compressionTriggered: boolean
  }
}

/** 压缩查询函数签名（由 ClaudeEngine 提供） */
export type CompressQueryFn = (params: {
  systemPrompt: string
  prompt: string
  maxTokens: number
}) => Promise<string>

// ==================== 图片引用处理 ====================

/**
 * 匹配 JSONL 中的图片引用: ![image](imageKey)
 * imageKey 不含扩展名、不含路径分隔符，例如 img_v3_02cc_xxx
 */
const IMAGE_MD_PATTERN = /!\[image\]\(([^)\s]+)\)/gi

/**
 * 在 session files 目录中查找包含指定 imageKey 的文件
 * 文件命名格式: img-{imageKey}.{ext}
 */
function findFileByKey(dir: string, imageKey: string): string | null {
  try {
    if (!existsSync(dir)) return null
    const files = readdirSync(dir)
    const match = files.find(f => f.includes(imageKey))
    return match ? join(dir, match) : null
  } catch {
    return null
  }
}

/**
 * 将消息内容中的图片引用替换为缓存分析结果或完整磁盘路径
 *
 * 缓存命中: ![image](key) → [图片: key]\n[此前分析结果]: analysis
 *   Claude 看到纯文本，不触发 vision-guard，直接复用
 *
 * 缓存未命中: ![image](key) → ![image](data/sessions/.../files/img-key.jpg)
 *   vision-guard 正常拦截 → Sub-Agent 分析 → 结果写入缓存
 *
 * 文件不存在: 原样保留（图片可能已被清理）
 */
function resolveImageReferences(
  content: string,
  imageCache: ImageAnalysisCache,
  sessionId: string,
): string {
  return content.replace(IMAGE_MD_PATTERN, (match, imageKey: string) => {
    // 缓存命中 → 替换为纯文本分析结果
    const entry = imageCache[imageKey]
    if (entry) {
      return `[图片: ${imageKey}]\n[此前分析结果]: ${entry.result}`
    }

    // 缓存未命中 → 解析 imageKey 为完整磁盘路径
    const filesDir = getFilesDir(sessionId)
    const fullPath = findFileByKey(filesDir, imageKey)
    if (fullPath) {
      const relPath = relative(process.cwd(), fullPath)
      return `![image](${relPath.startsWith('..') ? fullPath : relPath})`
    }

    // 文件不存在，原样保留
    return match
  })
}

// ==================== ContextBuilder ====================

export class ContextBuilder {
  private conversationStore: ConversationStore
  private systemPromptBuilder: SystemPromptBuilder
  private compressQuery: CompressQueryFn | null = null

  constructor(
    conversationStore: ConversationStore,
    systemPromptBuilder: SystemPromptBuilder,
  ) {
    this.conversationStore = conversationStore
    this.systemPromptBuilder = systemPromptBuilder
  }

  /** 设置压缩查询函数（延迟注入，避免循环依赖） */
  setCompressQuery(fn: CompressQueryFn): void {
    this.compressQuery = fn
  }

  /** 构建完整上下文（核心方法） */
  async build(sessionId: string, userMessage: string): Promise<ContextBuildResult> {
    const config = MEMORY_CONFIG.CONTEXT

    // 1. 加载全部历史
    const allHistory = this.conversationStore.loadSync(sessionId)
    const totalHistoryTokens = allHistory.reduce((sum, e) => sum + e.token_est, 0)

    // 1.5 加载图片分析缓存
    const imageCache = this.conversationStore.loadImageCache(sessionId)

    // 2. 构建 system prompt
    const systemPromptResult = this.systemPromptBuilder.build()
    const systemTokens = estimateTokens(systemPromptResult.text)

    // 3. 计算可用预算
    const userMsgTokens = estimateTokens(userMessage)
    const availableBudget = config.MAX_CONTEXT_TOKENS
      - config.OUTPUT_RESERVE - systemTokens - userMsgTokens - 500

    // 4. 判断是否需要压缩
    const needCompress =
      totalHistoryTokens > config.COMPRESS_THRESHOLD &&
      allHistory.length > config.MIN_ROUNDS_FOR_COMPRESS * 2

    if (!needCompress) {
      const recentMessages = this.selectRecent(allHistory, availableBudget)
      const resolvedMessages = this.resolveMessagesImageRefs(recentMessages, imageCache, sessionId)
      const recentTokens = resolvedMessages.reduce(
        (sum, m) => sum + estimateTokens(m.content), 0,
      )

      return {
        systemPrompt: systemPromptResult.text,
        messages: this.insertConversationBoundary(resolvedMessages),
        stats: {
          systemPromptTokens: systemTokens,
          summaryTokens: 0,
          recentTokens,
          totalTokens: systemTokens + recentTokens + userMsgTokens,
          totalRounds: Math.ceil(allHistory.filter(e => e.role === 'user').length),
          recentRounds: Math.ceil(resolvedMessages.filter(m => m.role === 'user').length),
          compressedRounds: 0,
          compressionTriggered: false,
        },
      }
    }

    // 5. 需要压缩
    const summaryBudget = Math.min(config.SUMMARY_BUDGET, Math.floor(availableBudget * 0.2))
    const recentBudget = availableBudget - summaryBudget

    // 6. 选取保鲜区（最少 4 轮）
    const recentMessages = this.selectRecent(allHistory, recentBudget, config.RECENT_WINDOW_MIN * 2)
    const recentStartIndex = allHistory.length - recentMessages.length

    // 7. 获取或生成压缩摘要（增量）
    const compressZone = allHistory.slice(0, recentStartIndex)
    let summary: CompressedSummary | null = null
    try {
      summary = await this.getOrCreateSummary(sessionId, compressZone, recentStartIndex)
    } catch (error) {
      console.warn('⚠️ 压缩摘要生成失败，回退到无摘要模式:', error)
    }

    // 8. 替换图片引用
    const resolvedMessages = this.resolveMessagesImageRefs(recentMessages, imageCache, sessionId)

    // 9. 组装消息列表
    const messages: MessageParam[] = []
    let summaryTokens = 0
    if (summary) {
      let summaryText = summary.summary
      if (estimateTokens(summaryText) > summaryBudget) {
        const ratio = summaryBudget / estimateTokens(summaryText)
        summaryText = summaryText.slice(0, Math.floor(summaryText.length * ratio))
      }
      summaryTokens = estimateTokens(summaryText)

      messages.push(
        { role: 'user', content: `[以下是之前对话的摘要]\n\n${summaryText}` },
        { role: 'assistant', content: '好的，我已了解之前的对话内容，请继续。' },
      )
    }
    messages.push(...resolvedMessages)

    const recentTokens = resolvedMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0,
    )
    const totalRounds = Math.ceil(allHistory.filter(e => e.role === 'user').length)

    return {
      systemPrompt: systemPromptResult.text,
      messages: this.insertConversationBoundary(messages),
      stats: {
        systemPromptTokens: systemTokens,
        summaryTokens,
        recentTokens,
        totalTokens: systemTokens + summaryTokens + recentTokens + userMsgTokens,
        totalRounds,
        recentRounds: Math.ceil(resolvedMessages.filter(m => m.role === 'user').length),
        compressedRounds: totalRounds - Math.ceil(resolvedMessages.filter(m => m.role === 'user').length),
        compressionTriggered: true,
      },
    }
  }

  /** 替换消息列表中的图片引用（缓存命中 → 纯文本，未命中 → 完整路径） */
  private resolveMessagesImageRefs(
    messages: MessageParam[],
    imageCache: ImageAnalysisCache,
    sessionId: string,
  ): MessageParam[] {
    return messages.map(msg => ({
      ...msg,
      content: resolveImageReferences(msg.content, imageCache, sessionId),
    }))
  }

  /** 从后往前选取消息，填满 token 预算 */
  private selectRecent(
    history: ConversationEntry[],
    budget: number,
    minEntries: number = 2,
  ): MessageParam[] {
    const selected: MessageParam[] = []
    let usedTokens = 0

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]!
      const tokens = entry.token_est || estimateTokens(entry.content)
      if (usedTokens + tokens > budget && selected.length >= minEntries) break
      selected.unshift({ role: entry.role, content: entry.content })
      usedTokens += tokens
    }

    return selected
  }

  /** 增量压缩：读取缓存 → 只压缩新增部分 → 更新缓存 */
  private async getOrCreateSummary(
    sessionId: string,
    compressZone: ConversationEntry[],
    coveredUntilIndex: number,
  ): Promise<CompressedSummary | null> {
    if (compressZone.length === 0) return null
    if (!this.compressQuery) {
      console.warn('⚠️ compressQuery 未设置，跳过压缩')
      return null
    }

    const cached = this.conversationStore.loadSummaryCache(sessionId)
    if (cached && cached.covered_until_index >= coveredUntilIndex) return cached

    const previousSummary = cached?.summary || null
    const newStartIndex = cached?.covered_until_index || 0
    const newMessages = compressZone.slice(newStartIndex)
    if (newMessages.length === 0) return cached

    const newMessagesText = newMessages
      .map(e => `${e.role}: ${e.content}`)
      .join('\n')

    let prompt = ''
    if (previousSummary) {
      prompt += `## 之前的摘要\n${previousSummary}\n\n`
    }
    prompt += `## 新增对话\n${newMessagesText}`

    const compressedText = await this.compressQuery({
      systemPrompt: COMPRESS_SYSTEM_PROMPT,
      prompt,
      maxTokens: MEMORY_CONFIG.CONTEXT.COMPRESS_MAX_TOKENS,
    })

    const newSummary: CompressedSummary = {
      session_id: sessionId,
      summary: compressedText,
      covered_until_index: coveredUntilIndex,
      covered_until_ts: compressZone[compressZone.length - 1]!.ts,
      summary_tokens: estimateTokens(compressedText),
      original_tokens: newMessages.reduce((s, e) => s + e.token_est, 0) + (cached?.original_tokens || 0),
      compression_ratio: 0,
      version: (cached?.version || 0) + 1,
      created_at: new Date().toISOString(),
    }
    newSummary.compression_ratio = newSummary.original_tokens > 0
      ? newSummary.summary_tokens / newSummary.original_tokens
      : 0

    this.conversationStore.saveSummaryCache(sessionId, newSummary)
    return newSummary
  }

  /**
   * 在历史消息和当前消息之间插入分界标记
   * 最后一条 user 消息视为"当前消息"，之前的都是"历史对话"
   *
   * 最终结构:
   *   [历史对话开始] → 历史 user/assistant ... → [当前对话] → 本轮 user 消息
   */
  private insertConversationBoundary(messages: MessageParam[]): MessageParam[] {
    if (messages.length < 2) return messages

    // 找到最后一条 user 消息的索引（即本轮消息）
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i
        break
      }
    }

    // 只有一条 user 消息（首轮对话），不需要分界
    if (lastUserIdx <= 0) return messages

    // 历史消息开头标记
    const historyStart: MessageParam[] = [
      { role: 'user', content: '[以下是历史对话记录，仅供参考上下文]' }
    ]

    // 当前对话分界标记
    const currentStart: MessageParam[] = [
      { role: 'user', content: '[历史对话结束，以下是当前对话]' }
    ]

    return [
      ...historyStart,
      ...messages.slice(0, lastUserIdx),
      ...currentStart,
      ...messages.slice(lastUserIdx),
    ]
  }

}
