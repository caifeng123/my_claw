/**
 * AgentEngine V4.1 - 智能分层记忆系统集成
 * 集成 MemoryDB、ConversationStore、ContextBuilder、SystemPromptBuilder
 */

import { ClaudeEngine } from './engine/claude-engine.js'
import { ToolManager } from './engine/tool-manager.js'
import { SessionManager } from './engine/session-manager.js'
import { StreamHandler } from './handlers/stream-handler.js'
import { MemoryDB } from '../memory/memory-db.js'
import { ConversationStore } from '../memory/conversation-store.js'
import { SystemPromptBuilder } from './engine/system-prompt-builder.js'
import { ContextBuilder } from './engine/context-builder.js'
import { createMemoryTools } from './tools/memory-tools.js'
import type {
  SessionConfig,
  AgentResponse,
  EventHandlers,
  SessionState
} from './types/agent.js'

interface SimpleMessage {
  role: 'user' | 'assistant'
  content: string
}

export class AgentEngine {
  private claudeEngine: ClaudeEngine
  private toolManager: ToolManager
  private sessionManager: SessionManager
  private streamHandler: StreamHandler
  private memoryDb: MemoryDB
  private conversationStore: ConversationStore
  private contextBuilder: ContextBuilder

  constructor() {
    // 1. 初始化记忆数据库（SQLite + FTS5）
    this.memoryDb = new MemoryDB()

    // 2. 初始化对话持久化
    this.conversationStore = new ConversationStore()

    // 3. 初始化 System Prompt 构建器（注入 MemoryDB）
    const systemPromptBuilder = new SystemPromptBuilder(this.memoryDb)

    // 4. 初始化上下文构建器
    this.contextBuilder = new ContextBuilder(this.conversationStore, systemPromptBuilder)

    // 5. 初始化 Claude 引擎
    this.claudeEngine = new ClaudeEngine()

    // 6. 注入压缩查询函数（延迟注入，避免循环依赖）
    this.contextBuilder.setCompressQuery(
      this.claudeEngine.compressQuery.bind(this.claudeEngine)
    )

    // 7. 初始化工具管理器并注册记忆工具
    this.toolManager = new ToolManager()
    const memoryTools = createMemoryTools(this.memoryDb)
    this.toolManager.registerTools(memoryTools)
    // 共享 ToolManager 给 ClaudeEngine
    this.claudeEngine.toolManager = this.toolManager

    // 8. 初始化会话管理器（注入 ConversationStore + ContextBuilder）
    this.sessionManager = new SessionManager(this.conversationStore, this.contextBuilder)

    // 9. 初始化流处理器
    this.streamHandler = new StreamHandler()

    console.log('🤖 Agent引擎 V4.1 初始化完成（智能分层记忆系统）')
  }

  /**
   * 发送消息给Agent（非流式）
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

      // 添加用户消息到会话（持久化到 JSONL）
      const userMessage: SimpleMessage = {
        role: 'user',
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 通过 ContextBuilder 构建上下文（FTS5 记忆检索 + 对话压缩）
      const context = await this.sessionManager.buildContext(sessionId, message)

      console.log(`📊 上下文构建完成 [session=${sessionId}]:`, {
        systemPromptTokens: context.stats.systemPromptTokens,
        summaryTokens: context.stats.summaryTokens,
        recentTokens: context.stats.recentTokens,
        totalTokens: context.stats.totalTokens,
        compressionTriggered: context.stats.compressionTriggered,
        totalRounds: context.stats.totalRounds,
        recentRounds: context.stats.recentRounds,
      })

      // 发送消息给Claude（带 systemPrompt）
      const response = await this.claudeEngine.sendMessage(
        context.messages,
        context.systemPrompt,
      )

      // 添加助手响应到会话（持久化）
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

      // 添加用户消息到会话（持久化到 JSONL）
      const userMessage: SimpleMessage = {
        role: 'user',
        content: message,
      }
      this.sessionManager.addMessage(sessionId, userMessage)

      // 通过 ContextBuilder 构建上下文
      const context = await this.sessionManager.buildContext(sessionId, message)

      console.log(`📊 上下文构建完成(流式) [session=${sessionId}]:`, {
        systemPromptTokens: context.stats.systemPromptTokens,
        compressionTriggered: context.stats.compressionTriggered,
        totalRounds: context.stats.totalRounds,
        recentRounds: context.stats.recentRounds,
      })

      // 设置流式处理器
      if (eventHandlers) {
        this.streamHandler.setEventHandlers(eventHandlers)
      }

      // 发送流式消息给Claude（带 systemPrompt）
      const responseContent = await this.claudeEngine.sendMessageStream(
        context.messages,
        eventHandlers || this.streamHandler.getEventHandlers(),
        context.systemPrompt,
      )

      // 添加助手响应到会话（持久化）
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

  // ==================== 工具管理 ====================

  /**
   * 注册工具
   */
  registerTool(options: any): void {
    this.toolManager.registerTool(options)
  }

  /**
   * 获取所有工具名称
   */
  getToolNames(): string[] {
    return this.toolManager.getToolNames()
  }

  // ==================== 会话管理 ====================

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

  // ==================== 事件处理 ====================

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

  // ==================== 记忆系统 ====================

  /**
   * 获取 MemoryDB 实例（供外部使用，如 CLI、路由）
   */
  getMemoryDb(): MemoryDB {
    return this.memoryDb
  }

  /**
   * 获取 ConversationStore 实例
   */
  getConversationStore(): ConversationStore {
    return this.conversationStore
  }
}

// 导出默认实例
export const agentEngine = new AgentEngine()

export default AgentEngine
