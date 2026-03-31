/**
 * SessionManager V5.0 - Resume 模式会话管理
 *
 * 改造说明：
 *   V4.x: 调用 ContextBuilder.build() 手动拼装上下文（裁剪/压缩/摘要/图片替换）
 *   V5.0: 上下文管理完全交给 SDK resume 机制，SessionManager 简化为：
 *     1. 内存中维护 SessionState（会话元数据）
 *     2. ConversationStore 保留为辅助（记忆系统、CLI 查看、定时任务回溯）
 *     3. 不再调用 ContextBuilder.build()
 *
 * 核心变化：
 *   - 移除 buildContext() 方法（ContextBuilder 不再作为上下文管理核心）
 *   - addMessage() 仍然写入 ConversationStore（辅助用途）
 *   - SystemPromptBuilder 改为直接暴露，由 AgentEngine 调用
 */

import type { SessionConfig, SessionState } from '../types/agent.js'
import { ConversationStore } from '../../memory/conversation-store.js'
import { estimateTokens } from '../../memory/config.js'

// 简化消息类型
type SimpleMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

export class SessionManager {
  private sessions: Map<string, SessionState>
  private conversationStore: ConversationStore

  constructor(conversationStore: ConversationStore) {
    this.sessions = new Map()
    this.conversationStore = conversationStore
    console.log('📋 SessionManager V5.0 初始化完成（Resume 模式）')
  }

  /**
   * 创建新会话
   */
  createSession(config: SessionConfig): SessionState {
    const now = new Date()
    const session: SessionState = {
      sessionId: config.sessionId,
      userId: config.userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      contextLength: 0,
    }

    this.sessions.set(config.sessionId, session)

    // 检查 ConversationStore 中是否已有历史（用于日志提示）
    const existingHistory = this.conversationStore.loadSync(config.sessionId)
    if (existingHistory.length > 0) {
      console.log(`💾 会话 ${config.sessionId} 发现 ${existingHistory.length} 条本地历史记录`)
    }

    console.log(`✅ 会话创建成功: ${config.sessionId}`)
    return session
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) || null
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /**
   * 向会话添加消息并持久化到 ConversationStore
   *
   * [RESUME 模式说明]:
   *   ConversationStore 写入仅用于辅助目的（记忆系统、CLI、定时任务回溯），
   *   不再作为下一轮对话上下文的来源。上下文由 SDK resume 机制自动管理。
   */
  addMessage(sessionId: string, message: SimpleMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    // 提取文本内容
    const content = this.extractTextContent(message.content)
    const role = message.role as 'user' | 'assistant' | 'system'

    // 持久化到 ConversationStore（JSONL 文件 → 辅助用途）
    this.conversationStore.append(sessionId, role, content)

    // 更新内存中的会话状态
    session.updatedAt = new Date()
    session.contextLength += estimateTokens(content)
  }

  /**
   * 获取会话的原始消息历史（兼容旧接口，用于 CLI / API 查看）
   */
  getMessages(sessionId: string): SimpleMessage[] {
    const history = this.conversationStore.loadSync(sessionId)
    return history.map(entry => ({
      role: entry.role,
      content: entry.content,
    }))
  }

  /**
   * 清空会话消息
   */
  clearMessages(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    this.conversationStore.deleteSession(sessionId)
    session.messages = []
    session.contextLength = 0
    session.updatedAt = new Date()
    console.log(`🗑️ 会话 ${sessionId} 对话已清空`)
  }

  /**
   * 获取所有活跃会话
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 获取用户的所有会话
   */
  getUserSessions(userId: string): SessionState[] {
    return Array.from(this.sessions.values()).filter(
      session => session.userId === userId
    )
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now()
    let cleanedCount = 0

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.updatedAt.getTime() > maxAge) {
        this.sessions.delete(sessionId)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 清理了 ${cleanedCount} 个过期会话`)
    }

    return cleanedCount
  }

  /**
   * 获取会话统计信息
   */
  getSessionStats(): {
    totalSessions: number
    activeSessions: number
    totalMessages: number
    averageMessagesPerSession: number
    persistedSessions: number
  } {
    const totalSessions = this.sessions.size
    const persistedSessions = this.conversationStore.listSessions().length

    let totalMessages = 0
    for (const [, session] of this.sessions) {
      const history = this.conversationStore.loadSync(session.sessionId)
      totalMessages += history.length
    }

    return {
      totalSessions,
      activeSessions: totalSessions,
      totalMessages,
      averageMessagesPerSession: totalSessions > 0 ? totalMessages / totalSessions : 0,
      persistedSessions,
    }
  }

  // ==================== 内部方法 ====================

  private extractTextContent(content: string | any[]): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')
    }
    return String(content)
  }
}
