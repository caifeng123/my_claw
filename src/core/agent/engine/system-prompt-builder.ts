/**
 * SystemPromptBuilder - 组装 systemPrompt（静态层 + 动态记忆）
 * V4.1 - 用户消息直传 FTS5 搜索，自适应 Budget
 */

import * as fs from 'node:fs'
import { MemoryDB, type MemoryEntry } from '../../memory/memory-db.js'
import { MEMORY_CONFIG, estimateTokens, getDynamicMemoryBudget } from '../../memory/config.js'

// ==================== 类型定义 ====================

export interface BuildStats {
  soulTokens: number
  claudeTokens: number
  memoryTokens: number
  totalTokens: number
  memoryCount: number
  searchQuery: string
  fallbackUsed: boolean
}

export interface SystemPromptResult {
  text: string
  stats: BuildStats
}

// ==================== SystemPromptBuilder ====================

export class SystemPromptBuilder {
  private memoryDb: MemoryDB

  constructor(memoryDb: MemoryDB) {
    this.memoryDb = memoryDb
  }

  /**
   * 构建完整 System Prompt
   * @param userMessage 当前用户消息，用于 FTS5 检索相关记忆
   * @param conversationTokens 当前对话已用 token（用于自适应 budget）
   */
  build(userMessage: string, conversationTokens: number = 0): SystemPromptResult {
    const { SOUL, CLAUDE } = MEMORY_CONFIG.TOKEN_BUDGET

    // 1. 读取 SOUL.md（截断至预算）
    const soul = this.loadAndTruncate('./data/SOUL.md', SOUL)

    // 2. 读取 CLAUDE.md（截断至预算）
    const claude = this.loadAndTruncate('./data/CLAUDE.md', CLAUDE)

    // 3. 用户消息直传 FTS5 搜索相关记忆
    const searchQuery = userMessage.slice(0, 100)
    let memories = this.memoryDb.search(searchQuery, 50)
    let fallbackUsed = false

    // 4. 如果 FTS5 没命中，回退到 Top 重要性
    if (memories.length === 0) {
      memories = this.memoryDb.getTopMemories(50).map((e: MemoryEntry) => ({
        ...e,
        score: e.imp * 2.0,
        fts_rank: 0,
      }))
      fallbackUsed = true
    }

    // 5. 格式化记忆，按 budget 截断
    const dynamicBudget = getDynamicMemoryBudget(conversationTokens)
    const dynamicContent = this.formatMemories(memories, dynamicBudget)

    // 6. 组装
    const parts: string[] = []
    if (soul) parts.push(soul)
    if (claude) parts.push(claude)
    if (dynamicContent) parts.push(`\n## Active Memories\n${dynamicContent}`)
    const text = parts.join('\n\n')

    // 7. 统计
    const soulTokens = estimateTokens(soul)
    const claudeTokens = estimateTokens(claude)
    const memoryTokens = estimateTokens(dynamicContent)

    return {
      text,
      stats: {
        soulTokens,
        claudeTokens,
        memoryTokens,
        totalTokens: soulTokens + claudeTokens + memoryTokens,
        memoryCount: memories.length,
        searchQuery,
        fallbackUsed,
      },
    }
  }

  /**
   * 读取文件并按 token 预算截断
   */
  private loadAndTruncate(filePath: string, maxTokens: number): string {
    try {
      if (!fs.existsSync(filePath)) return ''
      const content = fs.readFileSync(filePath, 'utf-8')
      const tokens = estimateTokens(content)
      if (tokens <= maxTokens) return content

      // 按比例截断
      const ratio = maxTokens / tokens
      const maxChars = Math.floor(content.length * ratio)
      return content.slice(0, maxChars) + '\n\n[... 内容已截断以适配 token 预算]'
    } catch (error) {
      console.warn(`⚠️ 读取 ${filePath} 失败:`, error)
      return ''
    }
  }

  /**
   * 格式化记忆条目，按 budget 截断
   */
  private formatMemories(entries: MemoryEntry[], budget: number): string {
    const lines: string[] = []
    let usedTokens = 0

    for (const entry of entries) {
      const line = `- [${entry.cat}](imp=${entry.imp}) ${entry.text}`
      const lineTokens = estimateTokens(line)
      if (usedTokens + lineTokens > budget) break
      lines.push(line)
      usedTokens += lineTokens
    }

    return lines.join('\n')
  }
}
