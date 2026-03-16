/**
 * SystemPromptBuilder - 组装 systemPrompt（静态层 + Top-N 常驻记忆）
 * V5.4 - 按重要性注入高优记忆，不做搜索，零匹配开销
 */

import * as fs from 'node:fs'
import { MemoryDB, type MemoryEntry } from '../../memory/memory-db.js'
import { MEMORY_CONFIG, estimateTokens } from '../../memory/config.js'

// ==================== 类型定义 ====================

export interface BuildStats {
  soulTokens: number
  claudeTokens: number
  memoryTokens: number
  memoryCount: number
  totalTokens: number
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
   * 构建 System Prompt
   * SOUL.md + CLAUDE.md + imp≥4 的常驻记忆（按重要性降序，受 budget 截断）
   */
  build(): SystemPromptResult {
    const { SOUL, CLAUDE } = MEMORY_CONFIG.TOKEN_BUDGET

    const soul = this.loadAndTruncate('./data/SOUL.md', SOUL)
    const claude = this.loadAndTruncate('./data/CLAUDE.md', CLAUDE)

    // 取 imp≥4 的记忆，按 imp 降序
    const topMemories = this.memoryDb.getTopMemories(50)
      .filter(e => e.imp >= 4)

    // 格式化，受 budget 截断
    const dynamicBudget = MEMORY_CONFIG.TOKEN_BUDGET.DYNAMIC_DEFAULT
    const { content: memoryContent, count: memoryCount } = this.formatMemories(topMemories, dynamicBudget)

    const parts: string[] = []
    if (soul) parts.push(soul)
    if (claude) parts.push(claude)
    if (memoryContent) parts.push(`\n## Active Memories\n${memoryContent}`)
    const text = parts.join('\n\n')

    const soulTokens = estimateTokens(soul)
    const claudeTokens = estimateTokens(claude)
    const memoryTokens = estimateTokens(memoryContent)

    return {
      text,
      stats: {
        soulTokens,
        claudeTokens,
        memoryTokens,
        memoryCount,
        totalTokens: soulTokens + claudeTokens + memoryTokens,
      },
    }
  }

  private loadAndTruncate(filePath: string, maxTokens: number): string {
    try {
      if (!fs.existsSync(filePath)) return ''
      const content = fs.readFileSync(filePath, 'utf-8')
      const tokens = estimateTokens(content)
      if (tokens <= maxTokens) return content

      const ratio = maxTokens / tokens
      const maxChars = Math.floor(content.length * ratio)
      return content.slice(0, maxChars) + '\n\n[... 内容已截断以适配 token 预算]'
    } catch (error) {
      console.warn(`⚠️ 读取 ${filePath} 失败:`, error)
      return ''
    }
  }

  /**
   * 格式化记忆条目（只用 text，不含 keywords），受 budget 截断
   */
  private formatMemories(entries: MemoryEntry[], budget: number): { content: string; count: number } {
    const lines: string[] = []
    let usedTokens = 0

    for (const entry of entries) {
      const line = `- [${entry.cat}](imp=${entry.imp}) ${entry.text}`
      const lineTokens = estimateTokens(line)
      if (usedTokens + lineTokens > budget) break
      lines.push(line)
      usedTokens += lineTokens
    }

    return { content: lines.join('\n'), count: lines.length }
  }
}
