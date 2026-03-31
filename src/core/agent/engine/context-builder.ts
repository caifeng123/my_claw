/**
 * ContextBuilder V6.0 - Resume 模式下的精简版
 *
 * 改造说明：
 *   V5.x: 核心上下文管理器 — 负责裁剪/压缩/摘要/图片替换/token预算
 *   V6.0: 上下文管理完全交给 SDK resume 机制，ContextBuilder 精简为：
 *     1. buildSystemPrompt() — 组装 system prompt（记忆注入）
 *     2. 保留类型导出（向后兼容）
 *
 * 移除的功能（由 SDK resume 自动处理）：
 *   - selectRecent() — 不再需要手动裁剪历史
 *   - getOrCreateSummary() — SDK 自动处理上下文溢出时的 compact
 *   - insertConversationBoundary() — 不再需要区分"历史"和"当前"
 *   - resolveImageReferences() — 图片处理交给 VisionGuard + SDK 原生能力
 *   - CompressQueryFn 注入 — 不再需要自建压缩
 *
 * 保留的功能：
 *   - SystemPrompt 构建 — 每次 query 仍需注入最新的高优记忆
 */

import { SystemPromptBuilder, type SystemPromptResult } from './system-prompt-builder.js'

// ==================== 类型定义（向后兼容） ====================

export interface MessageParam {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** @deprecated Resume 模式下不再需要完整的 ContextBuildResult */
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

/** @deprecated Resume 模式下不再需要压缩函数 */
export type CompressQueryFn = (params: {
  systemPrompt: string
  prompt: string
  maxTokens: number
}) => Promise<string>

// ==================== ContextBuilder ====================

export class ContextBuilder {
  private systemPromptBuilder: SystemPromptBuilder

  constructor(systemPromptBuilder: SystemPromptBuilder) {
    this.systemPromptBuilder = systemPromptBuilder
  }

  /**
   * 构建 System Prompt（核心方法）
   *
   * Resume 模式下，这是 ContextBuilder 唯一的核心职责：
   * 每次 query 前构建最新的 system prompt，注入高优记忆。
   *
   * 注意：resume 时 SDK 会使用新传入的 systemPrompt，
   * 所以每次都能注入最新的记忆内容。
   */
  buildSystemPrompt(): SystemPromptResult {
    return this.systemPromptBuilder.build()
  }

  // ==================== 兼容方法 ====================

  /** @deprecated Resume 模式下不再需要设置压缩函数 */
  setCompressQuery(_fn: CompressQueryFn): void {
    console.warn('⚠️ setCompressQuery() 在 Resume 模式下无效，压缩由 SDK 自动处理')
  }

  /**
   * @deprecated Resume 模式下不再需要手动构建上下文
   * 保留此方法仅为向后兼容，实际返回最简结构
   */
  async build(sessionId: string, userMessage: string): Promise<ContextBuildResult> {
    console.warn('⚠️ ContextBuilder.build() 在 Resume 模式下已弃用，上下文由 SDK resume 管理')
    const systemPromptResult = this.systemPromptBuilder.build()

    return {
      systemPrompt: systemPromptResult.text,
      messages: [{ role: 'user', content: userMessage }],
      stats: {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        summaryTokens: 0,
        recentTokens: 0,
        totalTokens: systemPromptResult.stats.totalTokens,
        totalRounds: 0,
        recentRounds: 0,
        compressedRounds: 0,
        compressionTriggered: false,
      },
    }
  }
}
