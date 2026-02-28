import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEngine } from './engine/claude-engine'
import { ToolManager } from './engine/tool-manager'
import { SessionManager } from './engine/session-manager'
import { StreamHandler } from './handlers/stream-handler'
import type{
  AgentConfig,
  SessionConfig,
  AgentResponse,
  EventHandlers,
  SessionState
} from './types/agent'

export class AgentEngine {
  private claudeEngine: ClaudeEngine
  private toolManager: ToolManager
  private sessionManager: SessionManager
  private streamHandler: StreamHandler
  private toolsConfig?: { mcpServers: any; allowedTools: string[] }

  constructor(config: Partial<AgentConfig> = {}) {
    this.claudeEngine = new ClaudeEngine(config)
    this.toolManager = new ToolManager()
    this.sessionManager = new SessionManager()
    this.streamHandler = new StreamHandler()

    console.log('🤖 Agent引擎初始化完成')
  }

  /**
   * 初始化工具配置
   */
  async initializeTools(): Promise<void> {
    try {
      this.toolsConfig = await this.toolManager.getTools()
    } catch (error) {
      console.error('工具配置初始化失败:', error)
      this.toolsConfig = { mcpServers: {}, allowedTools: [] }
    }
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
      const userMessage: SDKMessage = {
        role: 'user',
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 获取会话消息历史
      const messages = this.sessionManager.getMessages(sessionId)
      // 获取工具配置
      if (!this.toolsConfig) {
        await this.initializeTools()
      }
      // 发送消息给Claude
      const response = await this.claudeEngine.sendMessage(messages, this.toolsConfig)

      // 添加助手响应到会话
      const assistantMessage: SDKMessage = {
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
      const userMessage: SDKMessage = {
        role: 'user',
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 获取会话消息历史
      const messages = this.sessionManager.getMessages(sessionId)
      // 获取工具配置
      if (!this.toolsConfig) {
        await this.initializeTools()
      }

      // 设置流式处理器
      if (eventHandlers) {
        this.streamHandler.setEventHandlers(eventHandlers)
      }

      // 发送流式消息给Claude并获取响应内容
      const responseContent = await this.claudeEngine.sendMessageStream(
        messages,
        this.toolsConfig,
        eventHandlers || this.streamHandler.getEventHandlers()
      )

      // 添加助手响应到会话
      const assistantMessage: SDKMessage = {
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

  /**
   * 更新Agent配置
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.claudeEngine.updateConfig(config)
  }

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
}

// 导出默认实例
export const agentEngine = new AgentEngine()

export default AgentEngine