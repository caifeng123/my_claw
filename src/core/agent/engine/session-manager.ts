import type { SessionConfig, SessionState } from '../types/agent'
import { MemoryManager } from '../../memory/memory-manager.js'

// 简化消息类型
type SimpleMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

// 记忆集成配置
interface MemoryIntegrationConfig {
  enableMemory: boolean
  maxSessionMemorySize: number // 最大会话记忆大小（字节）
  enableSummary: boolean // 是否启用记忆摘要
}

export class SessionManager {
  private sessions: Map<string, SessionState>
  private maxContextLength: number
  private memoryManager: MemoryManager
  private memoryConfig: MemoryIntegrationConfig

  constructor(maxContextLength: number = 4000, memoryConfig?: Partial<MemoryIntegrationConfig>) {
    this.sessions = new Map()
    this.maxContextLength = maxContextLength

    // 初始化记忆配置
    this.memoryConfig = {
      enableMemory: memoryConfig?.enableMemory ?? true,
      maxSessionMemorySize: memoryConfig?.maxSessionMemorySize ?? 50000, // 默认50KB
      enableSummary: memoryConfig?.enableSummary ?? true,
    }

    // 初始化记忆管理器
    this.memoryManager = new MemoryManager()

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

    // 如果启用记忆，尝试加载已有的会话记忆
    if (this.memoryConfig.enableMemory) {
      const existingMemory = this.loadSessionMemory(config.sessionId)
      if (existingMemory) {
        console.log(`💾 会话 ${config.sessionId} 已加载历史记忆`)
      }
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

    // 如果启用记忆，保存会话记忆
    if (this.memoryConfig.enableMemory) {
      this.saveSessionMemory(session)
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

  // --- 记忆集成功能 ---

  /**
   * 保存会话记忆
   */
  private saveSessionMemory(session: SessionState): void {
    if (!this.memoryConfig.enableMemory) return

    try {
      const sessionPath = `sessions/${session.sessionId}/CLAUDE.md`
      const memoryContent = this.generateSessionMemoryContent(session)

      if (Buffer.byteLength(memoryContent, 'utf-8') > this.memoryConfig.maxSessionMemorySize) {
        console.warn(`⚠️ 会话 ${session.sessionId} 记忆文件过大，跳过保存`)
        return
      }

      this.memoryManager.writeMemoryFile(sessionPath, memoryContent)
      console.log(`💾 会话 ${session.sessionId} 记忆已保存`)
    } catch (error) {
      console.error(`❌ 保存会话 ${session.sessionId} 记忆失败:`, error)
    }
  }

  /**
   * 加载会话记忆
   */
  private loadSessionMemory(sessionId: string): string | null {
    if (!this.memoryConfig.enableMemory) return null

    try {
      const sessionPath = `sessions/${sessionId}/CLAUDE.md`
      const payload = this.memoryManager.readMemoryFile(sessionPath)
      return payload.content
    } catch (error) {
      // 记忆文件不存在是正常情况
      if (error instanceof Error && error.message.includes('not found')) {
        return null
      }
      console.error(`❌ 加载会话 ${sessionId} 记忆失败:`, error)
      return null
    }
  }

  /**
   * 生成会话记忆内容
   */
  private generateSessionMemoryContent(session: SessionState): string {
    const lines: string[] = []

    // 添加会话基本信息
    lines.push(`# 会话记忆: ${session.sessionId}`)
    lines.push(`
**创建时间:** ${session.createdAt.toISOString()}
**最后更新:** ${session.updatedAt.toISOString()}
**用户ID:** ${session.userId}
**消息数量:** ${session.messages.length}
**上下文长度:** ${session.contextLength} tokens
`)

    lines.push('## 完整对话历史（最新对话在前）')
    const reversedMessages = [...session.messages].reverse()
    reversedMessages.forEach((message, index) => {
      const content = Array.isArray(message.content)
        ? message.content.map((block: any) => block.type === 'text' ? block.text : '').join('')
        : message.content

      // 倒序编号：最新的为1，最旧的为最后
      lines.push(`### ${message.role}`)
      lines.push(content)
      lines.push('')
    })

    return lines.join('\n')
  }

  /**
   * 生成对话摘要
   */
  private generateConversationSummary(session: SessionState): string {
    const userMessages = session.messages.filter(msg => msg.role === 'user')
    const assistantMessages = session.messages.filter(msg => msg.role === 'assistant')

    if (userMessages.length === 0) return '暂无对话内容。'

    // 简单的摘要生成策略：提取关键信息
    const lastUserMessage = userMessages[userMessages.length - 1]
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]

    let summary = `本次对话共 ${session.messages.length} 条消息，涉及 ${userMessages.length} 次用户提问。`

    if (lastUserMessage && lastAssistantMessage) {
      const lastUserContent = Array.isArray(lastUserMessage.content)
        ? lastUserMessage.content.map((block: any) => block.type === 'text' ? block.text : '').join('')
        : lastUserMessage.content

      const lastAssistantContent = Array.isArray(lastAssistantMessage.content)
        ? lastAssistantMessage.content.map((block: any) => block.type === 'text' ? block.text : '').join('')
        : lastAssistantMessage.content

      summary += `\n\n**最近对话:**\n- 用户: ${this.truncateText(lastUserContent, 100)}\n- 助手: ${this.truncateText(lastAssistantContent, 100)}`
    }

    return summary
  }

  /**
   * 文本截断
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength) + '...'
  }


  /**
   * 获取用户全局记忆
   */
  getUserGlobalMemory(userId: string): string | null {
    if (!this.memoryConfig.enableMemory) return null

    try {
      const userGlobalPath = 'memory/user-global/CLAUDE.md'
      const payload = this.memoryManager.readMemoryFile(userGlobalPath)
      return payload.content
    } catch (error) {
      console.error(`❌ 获取用户 ${userId} 全局记忆失败:`, error)
      return null
    }
  }

  /**
   * 更新用户全局记忆
   */
  updateUserGlobalMemory(userId: string, content: string): boolean {
    if (!this.memoryConfig.enableMemory) return false

    try {
      const userGlobalPath = 'memory/user-global/CLAUDE.md'
      this.memoryManager.writeMemoryFile(userGlobalPath, content)
      console.log(`💾 用户 ${userId} 全局记忆已更新`)
      return true
    } catch (error) {
      console.error(`❌ 更新用户 ${userId} 全局记忆失败:`, error)
      return false
    }
  }

  /**
   * 获取项目记忆
   */
  getProjectMemory(): string | null {
    if (!this.memoryConfig.enableMemory) return null

    try {
      const projectPath = 'memory/project/CLAUDE.md'
      const payload = this.memoryManager.readMemoryFile(projectPath)
      return payload.content
    } catch (error) {
      console.error('❌ 获取项目记忆失败:', error)
      return null
    }
  }

  /**
   * 更新项目记忆
   */
  updateProjectMemory(content: string): boolean {
    if (!this.memoryConfig.enableMemory) return false

    try {
      const projectPath = 'memory/project/CLAUDE.md'
      this.memoryManager.writeMemoryFile(projectPath, content)
      console.log('💾 项目记忆已更新')
      return true
    } catch (error) {
      console.error('❌ 更新项目记忆失败:', error)
      return false
    }
  }

  /**
   * 搜索相关记忆
   */
  searchRelevantMemories(query: string, scope?: 'session' | 'user-global' | 'project', limit: number = 5): any[] {
    if (!this.memoryConfig.enableMemory) return []

    try {
      // 这里可以集成更高级的记忆搜索功能
      // 目前返回空数组，后续可以扩展
      // 使用参数避免ESLint警告
      console.log(`搜索记忆: ${query}, 范围: ${scope}, 限制: ${limit}`)
      return []
    } catch (error) {
      console.error('❌ 搜索记忆失败:', error)
      return []
    }
  }
}