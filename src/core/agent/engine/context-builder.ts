/**
 * ContextBuilder - 构建上下文窗口（截断/压缩/注入）
 * V4.1 - 保鲜区 + 压缩区模型，增量分段压缩
 */

import { ConversationStore, type ConversationEntry, type CompressedSummary } from '../../memory/conversation-store.js'
import { SystemPromptBuilder, type SystemPromptResult } from './system-prompt-builder.js'
import { MEMORY_CONFIG, estimateTokens, COMPRESS_SYSTEM_PROMPT } from '../../memory/config.js'

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

  /**
   * 设置压缩查询函数（延迟注入，避免循环依赖）
   */
  setCompressQuery(fn: CompressQueryFn): void {
    this.compressQuery = fn
  }

  /**
   * 构建完整上下文（核心方法）
   */
  async build(sessionId: string, userMessage: string): Promise<ContextBuildResult> {
    const config = MEMORY_CONFIG.CONTEXT

    // 1. 加载全部历史
    const allHistory = this.conversationStore.loadSync(sessionId)
    const totalHistoryTokens = allHistory.reduce((sum, e) => sum + e.token_est, 0)

    // 2. 构建 system prompt（直接传 userMessage 给 FTS5 检索记忆）
    const systemPromptResult = this.systemPromptBuilder.build(userMessage, totalHistoryTokens)
    const systemTokens = estimateTokens(systemPromptResult.text)

    // 3. 计算可用预算
    const userMsgTokens = estimateTokens(userMessage)
    const availableBudget = config.MAX_CONTEXT_TOKENS
      - config.OUTPUT_RESERVE - systemTokens - userMsgTokens - 500 // 500 为安全余量

    // 4. 判断是否需要压缩
    const needCompress =
      totalHistoryTokens > config.COMPRESS_THRESHOLD &&
      allHistory.length > config.MIN_ROUNDS_FOR_COMPRESS * 2

    if (!needCompress) {
      // 全量原文注入（从后往前填满预算）
      const recentMessages = this.selectRecent(allHistory, availableBudget)
      const recentTokens = recentMessages.reduce(
        (sum, m) => sum + estimateTokens(m.content), 0
      )

      return {
        systemPrompt: systemPromptResult.text,
        messages: recentMessages,
        stats: {
          systemPromptTokens: systemTokens,
          summaryTokens: 0,
          recentTokens,
          totalTokens: systemTokens + recentTokens + userMsgTokens,
          totalRounds: Math.ceil(allHistory.filter(e => e.role === 'user').length),
          recentRounds: Math.ceil(recentMessages.filter(m => m.role === 'user').length),
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

    // 8. 组装消息列表
    const messages: MessageParam[] = []
    let summaryTokens = 0
    if (summary) {
      // 摘要超过 budget 时截断
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
    messages.push(...recentMessages)

    const recentTokens = recentMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0
    )
    const totalRounds = Math.ceil(allHistory.filter(e => e.role === 'user').length)

    return {
      systemPrompt: systemPromptResult.text,
      messages,
      stats: {
        systemPromptTokens: systemTokens,
        summaryTokens,
        recentTokens,
        totalTokens: systemTokens + summaryTokens + recentTokens + userMsgTokens,
        totalRounds,
        recentRounds: Math.ceil(recentMessages.filter(m => m.role === 'user').length),
        compressedRounds: totalRounds - Math.ceil(recentMessages.filter(m => m.role === 'user').length),
        compressionTriggered: true,
      },
    }
  }

  /**
   * 从后往前选取消息，填满 token 预算
   */
  private selectRecent(
    history: ConversationEntry[],
    budget: number,
    minEntries: number = 2
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

  /**
   * 增量压缩：读取缓存 → 只压缩新增部分 → 更新缓存
   */
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

    // 调用 LLM 压缩
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
}
