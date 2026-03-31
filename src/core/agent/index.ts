/**
 * AgentEngine V5.0 - Resume 模式
 *
 * 改造说明：
 *   V4.x: 每次调用 query() 都是新 session，通过 ContextBuilder 手动拼接历史
 *   V5.0: 使用 SDK resume 机制续接对话，核心变化：
 *     1. sendMessage/sendMessageStream 只传当前用户消息给 ClaudeEngine
 *     2. ClaudeEngine 内部通过 resume 选项自动恢复完整对话上下文
 *     3. ContextBuilder 仅负责构建 system prompt（记忆注入）
 *     4. ConversationStore 保留为辅助（记忆系统、CLI、定时任务）
 *
 * 集成: MemoryDB、ConversationStore、SystemPromptBuilder、CronScheduler、SessionIdStore
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
import { CronScheduler } from '../cronjob/cron-scheduler.js'
import { createCronjobTools } from './tools/cronjob-tools.js'
import { calculatorTool, timeTool } from './tools/calculator.js'
import { createTavilyTools } from './tools/tavily-tools.js'
import { createLinkAnalyzeTools } from './tools/link-analyze.js'
import { initUserAuthService } from '../../services/feishu/user-auth-service.js'
import { registerAgentEngine } from '../agent-registry.js'
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
  private cronScheduler: CronScheduler
  private abortControllers: Map<string, AbortController> = new Map()

  constructor() {
    // 存储层
    this.memoryDb = new MemoryDB()
    this.conversationStore = new ConversationStore()

    // 上下文层（Resume 模式下仅负责 system prompt 构建）
    const systemPromptBuilder = new SystemPromptBuilder(this.memoryDb)
    this.contextBuilder = new ContextBuilder(systemPromptBuilder)

    // Claude 引擎层（内含 SessionIdStore，管理 resume 映射）
    this.claudeEngine = new ClaudeEngine()

    // [RESUME] 不再需要注入 compressQuery（SDK 自动处理上下文压缩）
    // this.contextBuilder.setCompressQuery(...)

    // 初始化会话管理器（Resume 模式下不再需要 ContextBuilder）
    this.sessionManager = new SessionManager(this.conversationStore)
    // 初始化流处理器
    this.streamHandler = new StreamHandler()

    // 注册到 registry
    registerAgentEngine(this)

    // 定时任务
    this.cronScheduler = new CronScheduler()

    // 工具层
    this.toolManager = new ToolManager()
    this.registerBuiltinTools()
    this.claudeEngine.toolManager = this.toolManager

    console.log('🤖 Agent引擎 V5.0 初始化完成（Resume 模式）')
  }

  /**
   * 统一注册所有内置工具
   */
  private registerBuiltinTools(): void {
    this.toolManager.registerTools([calculatorTool, timeTool])
    this.toolManager.registerTools(createTavilyTools())
    this.toolManager.registerTools(createMemoryTools(this.memoryDb))
    this.toolManager.registerTools(createCronjobTools(this.cronScheduler))
    this.toolManager.registerTools(createLinkAnalyzeTools())
    const appId = process.env.FEISHU_APP_ID || ''
    const appSecret = process.env.FEISHU_APP_SECRET || ''
    if (appId && appSecret) {
      initUserAuthService({ appId, appSecret })
    }
  }

  /**
   * 发送消息给Agent（非流式）
   *
   * [RESUME 改造]:
   *   原来: 调用 buildContext() 拼装历史 → 整个历史作为 prompt 发送
   *   现在: 只传当前消息 + sessionId → ClaudeEngine 内部通过 resume 恢复上下文
   */
  async sendMessage(
    sessionId: string,
    message: string,
    userId?: string,
    sessionContext?: string,
  ): Promise<AgentResponse> {
    try {
      // 获取或创建会话
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      // 添加用户消息到 ConversationStore（辅助用途：记忆系统、CLI）
      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      // [RESUME] 构建最新的 system prompt（注入高优记忆）
      const systemPromptResult = this.contextBuilder.buildSystemPrompt()

      // 将飞书会话上下文追加到 system prompt（而非 userMessage）
      // 这样 Agent 不会把 chatId/senderId 等内部 ID 当作对话内容复述给用户
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成 [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      // [RESUME] 只传当前消息 + sessionId，ClaudeEngine 通过 resume 恢复上下文
      const response = await this.claudeEngine.sendMessage(
        message,
        finalSystemPrompt,
        sessionId,
      )

      // 添加助手响应到 ConversationStore（辅助用途）
      const assistantMessage: SimpleMessage = { role: 'assistant', content: response.content }
      this.sessionManager.addMessage(sessionId, assistantMessage)

      return response
    } catch (error) {
      console.error('Agent消息处理错误:', error)
      throw new Error(`Agent处理失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * 流式发送消息给Agent
   *
   * [RESUME 改造]:
   *   原来: buildContext() 返回 messages 数组 → 传给 sendMessageStream
   *   现在: 只传当前消息 + sessionId → SDK resume 自动恢复完整上下文
   */
  async sendMessageStream(
    sessionId: string,
    message: string,
    userId?: string,
    eventHandlers?: EventHandlers,
    sessionContext?: string,
  ): Promise<void> {
    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    try {
      // 获取或创建会话
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      // 添加用户消息到 ConversationStore（辅助用途）
      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      // [RESUME] 构建最新的 system prompt
      const systemPromptResult = this.contextBuilder.buildSystemPrompt()

      // 将飞书会话上下文追加到 system prompt（而非 userMessage）
      // 这样 Agent 不会把 chatId/senderId 等内部 ID 当作对话内容复述给用户
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成(流式) [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      // 设置流式处理器
      if (eventHandlers) {
        this.streamHandler.setEventHandlers(eventHandlers)
      }

      // [RESUME] 只传当前消息 + sessionId，SDK resume 自动恢复完整上下文
      const responseContent = await this.claudeEngine.sendMessageStream(
        message,
        eventHandlers || this.streamHandler.getEventHandlers(),
        finalSystemPrompt,
        abortController,
        sessionId,
      )

      // 添加助手响应到 ConversationStore（辅助用途）
      const assistantMessage: SimpleMessage = { role: 'assistant', content: responseContent }
      this.sessionManager.addMessage(sessionId, assistantMessage)
    } catch (error) {
      if (abortController.signal.aborted) {
        console.log(`⏹️ 会话 ${sessionId} 已被用户中断`)
        return
      }
      console.error('Agent流式消息处理错误:', error)
      this.streamHandler.handleEvent({
        type: 'error',
        error: `Agent流式处理失败: ${error instanceof Error ? error.message : '未知错误'}`
      })
    } finally {
      this.abortControllers.delete(sessionId)
    }
  }

  // ==================== 工具管理 ====================

  registerTool(options: any): void {
    this.toolManager.registerTool(options)
  }

  getToolNames(): string[] {
    return this.toolManager.getToolNames()
  }

  // ==================== 会话管理 ====================

  createSession(config: SessionConfig): SessionState {
    return this.sessionManager.createSession(config)
  }

  getSession(sessionId: string): SessionState | null {
    return this.sessionManager.getSession(sessionId)
  }

  deleteSession(sessionId: string): boolean {
    // [RESUME] 同时清理 SDK session 映射
    this.claudeEngine.getSessionIdStore().delete(sessionId)
    return this.sessionManager.deleteSession(sessionId)
  }

  /**
   * 检查指定 session 是否存在 SDK resume 映射
   * 用于判断是否为新会话（首次对话 vs 续接对话）
   * 场景: feishu-agent-bridge 决定注入完整上下文还是仅注入 senderId
   */
  hasResumeSession(sessionId: string): boolean {
    return this.claudeEngine.getSessionIdStore().has(sessionId)
  }

  abortSession(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
      return true
    }
    return false
  }

  getSessionStats(): any {
    return this.sessionManager.getSessionStats()
  }

  cleanupExpiredSessions(maxAge?: number): number {
    // [RESUME] 同步清理过期的 SDK session 映射
    this.claudeEngine.getSessionIdStore().cleanup()
    return this.sessionManager.cleanupExpiredSessions(maxAge)
  }

  // ==================== 事件处理 ====================

  setEventHandlers(eventHandlers: EventHandlers): void {
    this.streamHandler.setEventHandlers(eventHandlers)
  }

  createWebSocketHandler(ws: WebSocket): EventHandlers {
    return this.streamHandler.createWebSocketHandler(ws)
  }

  createHTTPStreamHandler(write: (chunk: string) => void): EventHandlers {
    return this.streamHandler.createHTTPStreamHandler(write)
  }

  // ==================== 记忆系统 ====================

  getMemoryDb(): MemoryDB {
    return this.memoryDb
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore
  }

  // ==================== CronJob ====================

  getCronScheduler(): CronScheduler {
    return this.cronScheduler
  }
}

// 导出默认实例
export const agentEngine = new AgentEngine()

export default AgentEngine
