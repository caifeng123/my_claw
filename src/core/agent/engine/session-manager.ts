/**
 * SessionManager V4.1 - 基于 ConversationStore + ContextBuilder 的会话管理
 * 替代原有的纯内存会话管理，支持持久化和智能上下文构建
 */

import type { SessionConfig, SessionState } from '../types/agent.js'
import { ConversationStore } from '../../memory/conversation-store.js'
import { ContextBuilder, type ContextBuildResult, type MessageParam } from './context-builder.js'
import { estimateTokens } from '../../memory/config.js'

// 简化消息类型
type SimpleMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

export class SessionManager {
  private sessions: Map<string, SessionState>
  private conversationStore: ConversationStore
  private contextBuilder: ContextBuilder

  constructor(conversationStore: ConversationStore, contextBuilder: ContextBuilder) {
    this.sessions = new Map()
    this.conversationStore = conversationStore
    this.contextBuilder = contextBuilder
    console.log('📋 SessionManager V4.1 初始化完成')
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

    // 尝试从 ConversationStore 恢复历史
    const existingHistory = this.conversationStore.loadSync(config.sessionId)
    if (existingHistory.length > 0) {
      console.log(`💾 会话 ${config.sessionId} 已恢复 ${existingHistory.length} 条历史记录`)
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
   * 向会话添加消息并持久化
   */
  addMessage(sessionId: string, message: SimpleMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    // 提取文本内容
    const content = this.extractTextContent(message.content)
    const role = message.role as 'user' | 'assistant' | 'system'

    // 持久化到 ConversationStore（JSONL 文件）
    this.conversationStore.append(sessionId, role, content)

    // 更新内存中的会话状态（轻量引用，不保存完整历史）
    session.updatedAt = new Date()
    session.contextLength += estimateTokens(content)
  }

  /**
   * 构建上下文（核心方法，取代原有 getMessages）
   * 通过 ContextBuilder 智能构建：关键词记忆检索 + 对话压缩 + 保鲜区
   */
  async buildContext(sessionId: string, userMessage: string): Promise<ContextBuildResult> {
    return this.contextBuilder.build(sessionId, userMessage)
  }

  /**
   * 获取会话的原始消息历史（兼容旧接口）
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

    // 删除对话持久化文件（包括摘要缓存）
    this.conversationStore.deleteSession(sessionId)

    session.messages = []
    session.contextLength = 0
    session.updatedAt = new Date()
    console.log(`🗑️ 会话 ${sessionId} 已清空`)
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

    // 从 ConversationStore 获取消息总数
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

  /**
   * 提取文本内容（兼容字符串和数组格式）
   */
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
