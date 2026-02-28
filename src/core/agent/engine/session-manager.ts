import type { SessionConfig, SessionState } from '../types/agent'

// 简化消息类型
type SimpleMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

export class SessionManager {
  private sessions: Map<string, SessionState>
  private maxContextLength: number

  constructor(maxContextLength: number = 4000) {
    this.sessions = new Map()
    this.maxContextLength = maxContextLength
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
   * 向会话添加消息
   */
  addMessage(sessionId: string, message: SimpleMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    session.messages.push(message)
    session.updatedAt = new Date()

    // 更新上下文长度（简单估算）
    session.contextLength += this.estimateTokenCount(message)

    // 如果上下文过长，进行压缩
    if (session.contextLength > this.maxContextLength) {
      this.compressContext(session)
    }
  }

  /**
   * 获取会话消息历史
   */
  getMessages(sessionId: string): SimpleMessage[] {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    return [...session.messages]
  }

  /**
   * 清空会话消息
   */
  clearMessages(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`)
    }

    session.messages = []
    session.contextLength = 0
    session.updatedAt = new Date()
  }

  /**
   * 压缩会话上下文
   */
  private compressContext(session: SessionState): void {
    // 简单的上下文压缩策略：保留最近的对话，删除中间部分
    const totalMessages = session.messages.length

    if (totalMessages <= 10) {
      return // 消息太少，不需要压缩
    }

    // 保留系统消息（如果有）和最近的5条消息
    const systemMessages = session.messages.filter(msg =>
      msg.role === 'system'
    )
    const recentMessages = session.messages.slice(-5)

    session.messages = [...systemMessages, ...recentMessages]

    // 重新计算上下文长度
    session.contextLength = session.messages.reduce((total, msg) =>
      total + this.estimateTokenCount(msg), 0
    )

    console.log(`📊 会话 ${session.sessionId} 上下文已压缩`)
  }

  /**
   * 估算消息的token数量
   */
  private estimateTokenCount(message: SimpleMessage): number {
    // 简单的token估算：每个中文字符约1.5个token，英文字符约0.25个token
    let text = ''

    if (Array.isArray(message.content)) {
      text = message.content.map(block => {
        if (block.type === 'text') {
          return block.text
        }
        return ''
      }).join('')
    } else if (typeof message.content === 'string') {
      text = message.content
    }

    // 估算中英文混合的token数量
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0
    const englishChars = text.length - chineseChars

    return Math.ceil(chineseChars * 1.5 + englishChars * 0.25)
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
  } {
    const totalSessions = this.sessions.size
    const totalMessages = Array.from(this.sessions.values()).reduce(
      (total, session) => total + session.messages.length, 0
    )

    return {
      totalSessions,
      activeSessions: totalSessions,
      totalMessages,
      averageMessagesPerSession: totalSessions > 0 ? totalMessages / totalSessions : 0,
    }
  }
}