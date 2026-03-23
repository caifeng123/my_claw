/**
 * ConversationStore - JSONL 对话历史持久化
 * V5.0 - 存储路径统一至 data/sessions/{sessionId}/ 目录
 *
 * 每个 session 的全部数据集中在同一目录下：
 *   data/sessions/{sessionId}/
 *   ├── history.jsonl      ← 对话历史
 *   ├── summary.json       ← 压缩摘要缓存
 *   ├── images.json        ← 图片分析缓存
 *   └── files/             ← 用户发送 & Bot 生成的文件
 */

import * as fs from 'node:fs'
import {
  getHistoryPath,
  getSummaryPath,
  getImageCachePath,
  getSessionDir,
  listAllSessionIds,
  SESSIONS_ROOT,
} from '../../utils/paths.js'
import { MEMORY_CONFIG, estimateTokens } from './config.js'

// ==================== 类型定义 ====================

export interface ConversationEntry {
  ts: number
  role: 'user' | 'assistant' | 'system'
  content: string
  session_id: string
  token_est: number
}

export interface CompressedSummary {
  session_id: string
  summary: string
  covered_until_index: number
  covered_until_ts: number
  summary_tokens: number
  original_tokens: number
  compression_ratio: number
  version: number
  created_at: string
}

export interface LoadByBudgetResult {
  entries: ConversationEntry[]
  truncated: boolean
  totalRounds: number
  loadedRounds: number
}

/** 图片分析缓存条目 */
export interface ImageAnalysisEntry {
  /** 分析结果文本 */
  result: string
  /** 分析时间戳 */
  analyzedAt: number
  /** 分析时的用户上下文（用于判断是否需要重新分析） */
  context: string
}

/** 图片分析缓存: imageKey → ImageAnalysisEntry */
export type ImageAnalysisCache = Record<string, ImageAnalysisEntry>

/** 图片分析缓存最大条目数 */
const IMAGE_CACHE_MAX_ENTRIES = 500

// ==================== ConversationStore ====================

export class ConversationStore {
  constructor() {
    // 确保 sessions 根目录存在
    if (!fs.existsSync(SESSIONS_ROOT)) {
      fs.mkdirSync(SESSIONS_ROOT, { recursive: true })
    }
    console.log(`💬 ConversationStore 初始化完成: ${SESSIONS_ROOT}`)
  }

  // ==================== 写入 ====================

  /**
   * 追加一条对话记录
   */
  append(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): ConversationEntry {
    const filePath = getHistoryPath(sessionId)
    const entry: ConversationEntry = {
      ts: Date.now(),
      role,
      content,
      session_id: sessionId,
      token_est: estimateTokens(content),
    }

    // 检查是否需要 rotate
    this.rotateIfNeeded(filePath)

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
    return entry
  }

  // ==================== 读取 ====================

  /**
   * 同步加载全部对话历史
   */
  loadSync(sessionId: string): ConversationEntry[] {
    const filePath = getHistoryPath(sessionId)
    if (!fs.existsSync(filePath)) return []

    const content = fs.readFileSync(filePath, 'utf-8')
    const entries: ConversationEntry[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as ConversationEntry)
      } catch {
        // 跳过损坏行
        console.warn(`⚠️ 跳过损坏的对话记录行: ${line.slice(0, 50)}...`)
      }
    }

    return entries
  }

  /**
   * 加载最近 N 条记录
   */
  loadRecent(sessionId: string, count: number): ConversationEntry[] {
    const all = this.loadSync(sessionId)
    return all.slice(-count)
  }

  /**
   * 按 token 预算加载（从后往前填满）
   */
  loadByTokenBudget(sessionId: string, budget: number): LoadByBudgetResult {
    const all = this.loadSync(sessionId)
    const selected: ConversationEntry[] = []
    let usedTokens = 0

    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i]!
      const tokens = entry.token_est || estimateTokens(entry.content)
      if (usedTokens + tokens > budget && selected.length > 0) break
      selected.unshift(entry)
      usedTokens += tokens
    }

    // 计算轮次（一个 user + assistant 为一轮）
    const totalRounds = Math.ceil(all.filter(e => e.role === 'user').length)
    const loadedRounds = Math.ceil(selected.filter(e => e.role === 'user').length)

    return {
      entries: selected,
      truncated: selected.length < all.length,
      totalRounds,
      loadedRounds,
    }
  }

  // ==================== 会话管理 ====================

  /**
   * 删除会话（删除整个 session 目录）
   */
  deleteSession(sessionId: string): void {
    const sessionDir = getSessionDir(sessionId)
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true })
      console.log(`🗑️ 已删除会话目录: ${sessionDir}`)
    }
  }

  /**
   * 列出所有会话 ID
   */
  listSessions(): string[] {
    return listAllSessionIds()
  }

  // ==================== 摘要缓存 ====================

  /**
   * 加载摘要缓存
   */
  loadSummaryCache(sessionId: string): CompressedSummary | null {
    const summaryPath = getSummaryPath(sessionId)
    if (!fs.existsSync(summaryPath)) return null

    try {
      const content = fs.readFileSync(summaryPath, 'utf-8')
      return JSON.parse(content) as CompressedSummary
    } catch {
      // 缓存损坏，删除
      console.warn(`⚠️ 摘要缓存损坏，已删除: ${summaryPath}`)
      fs.unlinkSync(summaryPath)
      return null
    }
  }

  /**
   * 保存摘要缓存
   */
  saveSummaryCache(sessionId: string, summary: CompressedSummary): void {
    const summaryPath = getSummaryPath(sessionId)
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
  }

  // ==================== 图片分析缓存 ====================

  /**
   * 加载图片分析缓存
   */
  loadImageCache(sessionId: string): ImageAnalysisCache {
    const cachePath = getImageCachePath(sessionId)
    if (!fs.existsSync(cachePath)) return {}

    try {
      const content = fs.readFileSync(cachePath, 'utf-8')
      return JSON.parse(content) as ImageAnalysisCache
    } catch {
      console.warn(`⚠️ 图片分析缓存损坏，已删除: ${cachePath}`)
      fs.unlinkSync(cachePath)
      return {}
    }
  }

  /**
   * 保存图片分析缓存（含淘汰策略：超过上限保留最新的）
   */
  saveImageCache(sessionId: string, cache: ImageAnalysisCache): void {
    const cachePath = getImageCachePath(sessionId)

    // 淘汰策略：超过上限时按 analyzedAt 保留最新的
    let cacheToSave = cache
    const entries = Object.entries(cache)
    if (entries.length > IMAGE_CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => b[1].analyzedAt - a[1].analyzedAt)
      cacheToSave = Object.fromEntries(entries.slice(0, IMAGE_CACHE_MAX_ENTRIES))
    }

    fs.writeFileSync(cachePath, JSON.stringify(cacheToSave, null, 2), 'utf-8')
  }

  /**
   * 更新单条图片分析缓存（便捷方法，读取-修改-写回）
   */
  updateImageCacheEntry(sessionId: string, imageKey: string, entry: ImageAnalysisEntry): void {
    const cache = this.loadImageCache(sessionId)
    cache[imageKey] = entry
    this.saveImageCache(sessionId, cache)
  }

  // ==================== 内部方法 ====================

  /**
   * 文件 rotate：超过大小限制时归档
   */
  private rotateIfNeeded(filePath: string): void {
    if (!fs.existsSync(filePath)) return

    const stat = fs.statSync(filePath)
    if (stat.size <= MEMORY_CONFIG.CONVERSATION.MAX_FILE_SIZE) return

    // 删除最旧的归档文件
    const maxRotated = MEMORY_CONFIG.CONVERSATION.MAX_ROTATED_FILES
    const oldestPath = `${filePath}.${maxRotated}`
    if (fs.existsSync(oldestPath)) {
      fs.unlinkSync(oldestPath)
    }

    // 依次重命名归档文件
    for (let i = maxRotated - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`
      const to = `${filePath}.${i + 1}`
      if (fs.existsSync(from)) {
        fs.renameSync(from, to)
      }
    }

    // 当前文件归档为 .1
    fs.renameSync(filePath, `${filePath}.1`)
    console.log(`📦 对话文件已归档: ${filePath}.1`)
  }
}
