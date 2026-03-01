import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEngine } from './engine/claude-engine'
import { ToolManager } from './engine/tool-manager'
import { SessionManager } from './engine/session-manager'
import { StreamHandler } from './handlers/stream-handler'
import type{
  SessionConfig,
  AgentResponse,
  EventHandlers,
  SessionState
} from './types/agent'

interface SimpleMessage {
  role: 'user' | 'assistant'
  content: string
}
export class AgentEngine {
  private claudeEngine: ClaudeEngine
  private toolManager: ToolManager
  private sessionManager: SessionManager
  private streamHandler: StreamHandler

  constructor() {
    this.claudeEngine = new ClaudeEngine()
    this.toolManager = new ToolManager()
    this.sessionManager = new SessionManager()
    this.streamHandler = new StreamHandler()

    console.log('🤖 Agent引擎初始化完成')
  }

  /**
   * 发送消息给Agent
   */
  async sendMessage(
    sessionId: string,
    message: string,
    userId?: string,
  ): Promise<AgentResponse> {
    try {
      // 获取或创建会话
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      // 添加用户消息到会话
      const userMessage: SimpleMessage = {
        role: 'user',
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 获取会话消息历史
      const messages = this.sessionManager.getMessages(sessionId)
      // 获取工具配置（每次调用都重新获取，确保独立的 MCP server 实例）
      const toolsConfig = await this.toolManager.getTools()
      // 发送消息给Claude
      const response = await this.claudeEngine.sendMessage(messages, toolsConfig)

      // 添加助手响应到会话
      const assistantMessage: SimpleMessage = {
        role: 'assistant',
        content: response.content,
      }
      this.sessionManager.addMessage(sessionId, assistantMessage)

      return response
    } catch (error) {
      console.error('Agent消息处理错误:', error)
      throw new Error(`Agent处理失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * 流式发送消息给Agent
   */
  async sendMessageStream(
    sessionId: string,
    message: string,
    userId?: string,
    eventHandlers?: EventHandlers
  ): Promise<void> {
    try {
      // 获取或创建会话
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      // 添加用户消息到会话
      const userMessage: SimpleMessage = {
        role: "user",
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 获取会话消息历史
      const messages = this.sessionManager.getMessages(sessionId)
      // 获取工具配置（每次调用都重新获取，确保独立的 MCP server 实例）
      const toolsConfig = await this.toolManager.getTools()

      // 设置流式处理器
      if (eventHandlers) {
        this.streamHandler.setEventHandlers(eventHandlers)
      }

      // 发送流式消息给Claude并获取响应内容
      const responseContent = await this.claudeEngine.sendMessageStream(
        messages,
        toolsConfig,
        eventHandlers || this.streamHandler.getEventHandlers()
      )

      // 添加助手响应到会话
      const assistantMessage: SimpleMessage = {
        role: 'assistant',
        content: responseContent,
      }
      this.sessionManager.addMessage(sessionId, assistantMessage)
    } catch (error) {
      console.error('Agent流式消息处理错误:', error)
      this.streamHandler.handleEvent({
        type: 'error',
        error: `Agent流式处理失败: ${error instanceof Error ? error.message : '未知错误'}`
      })
    }
  }

  /**
   * 注册工具
   */
  registerTool(options: any): void {
    this.toolManager.registerTool(options)
  }

  /**
   * 创建会话
   */
  createSession(config: SessionConfig): SessionState {
    return this.sessionManager.createSession(config)
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionState | null {
    return this.sessionManager.getSession(sessionId)
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    return this.sessionManager.deleteSession(sessionId)
  }

  /**
   * 获取会话统计
   */
  getSessionStats(): any {
    return this.sessionManager.getSessionStats()
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAge?: number): number {
    return this.sessionManager.cleanupExpiredSessions(maxAge)
  }

  /**
   * 获取所有工具名称
   */
  getToolNames(): string[] {
    return this.toolManager.getToolNames()
  }

  // /**
  //  * 更新Agent配置
  //  */
  // updateConfig(c): void {
  //   this.claudeEngine.updateConfig(config)
  // }

  /**
   * 设置流式事件处理器
   */
  setEventHandlers(eventHandlers: EventHandlers): void {
    this.streamHandler.setEventHandlers(eventHandlers)
  }

  /**
   * 创建WebSocket处理器
   */
  createWebSocketHandler(ws: WebSocket): EventHandlers {
    return this.streamHandler.createWebSocketHandler(ws)
  }

  /**
   * 创建HTTP流处理器
   */
  createHTTPStreamHandler(write: (chunk: string) => void): EventHandlers {
    return this.streamHandler.createHTTPStreamHandler(write)
  }

  // --- 记忆集成功能 ---

  /**
   * 获取用户全局记忆
   */
  getUserGlobalMemory(userId: string): string | null {
    return this.sessionManager.getUserGlobalMemory(userId)
  }

  /**
   * 更新用户全局记忆
   */
  updateUserGlobalMemory(userId: string, content: string): boolean {
    return this.sessionManager.updateUserGlobalMemory(userId, content)
  }

  /**
   * 获取项目记忆
   */
  getProjectMemory(): string | null {
    return this.sessionManager.getProjectMemory()
  }

  /**
   * 更新项目记忆
   */
  updateProjectMemory(content: string): boolean {
    return this.sessionManager.updateProjectMemory(content)
  }

  /**
   * 搜索相关记忆
   */
  searchRelevantMemories(query: string, scope?: 'session' | 'user-global' | 'project', limit: number = 5): any[] {
    return this.sessionManager.searchRelevantMemories(query, scope, limit)
  }

  /**
   * 获取会话记忆内容
   */
  getSessionMemory(sessionId: string): string | null {
    const session = this.sessionManager.getSession(sessionId)
    if (!session) return null

    // 这里可以返回会话的记忆内容，或者从文件系统加载
    // 目前返回空，后续可以扩展
    return null
  }

  /**
   * 保存会话记忆
   */
  saveSessionMemory(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId)
    if (!session) return false

    // 调用SessionManager的内部方法保存记忆
    // 注意：这里需要访问SessionManager的私有方法，可能需要调整
    // 目前返回false，后续可以扩展
    return false
  }
}

// 导出默认实例
export const agentEngine = new AgentEngine()

export default AgentEngine