/**
 * AgentEngine V5.3 - Resume 模式 + Skill 自迭代 (全量 Timeline 采集)
 *
 * V5.0: SDK resume 机制
 * V5.1: Skill 自迭代 (setInterval 驱动) — 已废弃
 * V5.2: Skill 自迭代 (CronJob 驱动) — Trace per-Skill 采集
 * V5.3: Skill 自迭代 (全量 Timeline 采集)
 *   - TraceCollector 改为 per-turn 全量 timeline 记录
 *   - 不在采集时做 Skill 归属判断
 *   - 读取时按 skill_start 位置 slice，按需获取各 Skill 视角
 *   - 同时兼容写入旧格式（per-skill JSONL），iteration-checker 无需改动
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
import { registerAgentEngine } from '../agent-registry.js'
import { TraceCollector } from '../self-iteration/trace-collector.js'
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

  // [SELF-ITERATION] Trace 采集（优化由 CronJob 驱动，不在此处）
  private traceCollector: TraceCollector

  constructor() {
    // 存储层
    this.memoryDb = new MemoryDB()
    this.conversationStore = new ConversationStore()

    // 上下文层
    const systemPromptBuilder = new SystemPromptBuilder(this.memoryDb)
    this.contextBuilder = new ContextBuilder(systemPromptBuilder)

    // Claude 引擎层
    this.claudeEngine = new ClaudeEngine()

    // 会话管理器
    this.sessionManager = new SessionManager(this.conversationStore)
    this.streamHandler = new StreamHandler()

    // [SELF-ITERATION] Trace 采集器
    this.traceCollector = new TraceCollector()

    // 注册到 registry
    registerAgentEngine(this)

    // 定时任务
    this.cronScheduler = new CronScheduler()

    // 工具层
    this.toolManager = new ToolManager()
    this.registerBuiltinTools()
    this.claudeEngine.toolManager = this.toolManager

    // [SELF-ITERATION] 确保内置 CronJob 存在
    this.ensureSelfIterationCronJob()

    console.log('🤖 Agent引擎 V5.3 初始化完成（Resume + Skill 自迭代 Timeline）')
  }

  /**
   * 注册所有内置工具
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
    }
  }

  /**
   * 确保 Skill 自迭代 CronJob 存在（幂等）
   * 每天 0 点执行，扫描所有有 trace 的 Skill
   */
  private ensureSelfIterationCronJob(): void {
    const store = this.cronScheduler.getStore()
    const existing = store.listJobs().find((j) => j.name === '__skill_self_iteration__')
    if (existing) return

    store.createJob({
      name: '__skill_self_iteration__',
      cron: '0 0 * * *',
      taskType: 'self_iteration',
      taskConfig: { type: 'self_iteration', skills: 'all' },
      notifyChatId: '',
      enabled: true,
    })

    console.log('⏰ [AgentEngine] Skill self-iteration CronJob registered (0 0 * * *)')
  }

  // ==================== EventTap — Trace 采集 ====================

  /**
   * 包装 eventHandlers，注入全量 timeline 采集
   *
   * V5.3 改造：
   *   - 不再维护 activeTraces / pendingSteps
   *   - 只做一件事：往 timeline 里 push 事件
   *   - Skill 归属判断完全交给读取时的 sliceForSkill()
   */
  private wrapWithTraceCollector(
    sessionId: string,
    userMessage: string,
    eventHandlers?: EventHandlers,
  ): EventHandlers {
    const tc = this.traceCollector
    const original = eventHandlers ?? {}

    // 启动 turn 级别的 timeline 记录
    tc.startTurn(sessionId, userMessage)

    return {
      ...original,

      onToolUseStart: async (
        toolName: string,
        input: any,
        parentToolUseId: string | null,
        toolUseId: string,
      ) => {
        if (toolName === 'Skill') {
          // Skill 工具调用 → 记录 skill_start
          const skillName = input?.skill || input?.name || input?.skill_name || 'unknown'
          tc.addEvent(sessionId, {
            ts: Date.now(),
            type: 'skill_start',
            skill: skillName,
            toolUseId,
            parentToolUseId,
            input: input ?? {},
          })
        } else {
          // 普通工具调用 → 记录 tool_start
          tc.addEvent(sessionId, {
            ts: Date.now(),
            type: 'tool_start',
            tool: toolName,
            toolUseId,
            parentToolUseId,
            input: input ?? {},
          })
        }

        await original.onToolUseStart?.(toolName, input, parentToolUseId, toolUseId)
      },

      onToolUseStop: async (
        toolName: string,
        result: any,
        parentToolUseId: string | null,
        toolUseId: string,
      ) => {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result)

        if (toolName === 'Skill') {
          // Skill tool_result 返回 → 记录 skill_ready
          tc.addEvent(sessionId, {
            ts: Date.now(),
            type: 'skill_ready',
            toolUseId,
            output: resultStr,
          })
        } else {
          // 普通工具结束 → 记录 tool_end
          const status = resultStr.toLowerCase().includes('error') ? 'error' as const : 'ok' as const
          tc.addEvent(sessionId, {
            ts: Date.now(),
            type: 'tool_end',
            tool: toolName,
            toolUseId,
            output: resultStr,
            status,
          })
        }

        await original.onToolUseStop?.(toolName, result, parentToolUseId, toolUseId)
      },

      onContentStop: async () => {
        // Turn 结束 → 关闭 timeline 并持久化
        await tc.finishTurn(sessionId, '')
        await original.onContentStop?.()
      },

      onError: async (error: string) => {
        // 异常时也关闭 timeline
        await tc.finishTurn(sessionId, `Error: ${error}`)
        await original.onError?.(error)
      },
    }
  }

  /**
   * 发送消息（非流式）
   */
  async sendMessage(
    sessionId: string,
    message: string,
    userId?: string,
    sessionContext?: string,
  ): Promise<AgentResponse> {
    try {
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      const systemPromptResult = this.contextBuilder.buildSystemPrompt()
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成 [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      const response = await this.claudeEngine.sendMessage(
        message,
        finalSystemPrompt,
        sessionId,
      )

      const assistantMessage: SimpleMessage = { role: 'assistant', content: response.content }
      this.sessionManager.addMessage(sessionId, assistantMessage)

      return response
    } catch (error) {
      console.error('Agent消息处理错误:', error)
      throw new Error(`Agent处理失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * 流式发送消息
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
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      const systemPromptResult = this.contextBuilder.buildSystemPrompt()
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成(流式) [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      // [SELF-ITERATION] 包装 eventHandlers，注入全量 timeline 采集
      const wrappedHandlers = this.wrapWithTraceCollector(
        sessionId,
        message,
        eventHandlers || this.streamHandler.getEventHandlers(),
      )

      this.streamHandler.setEventHandlers(wrappedHandlers)

      const responseContent = await this.claudeEngine.sendMessageStream(
        message,
        wrappedHandlers,
        finalSystemPrompt,
        abortController,
        sessionId,
      )

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
    this.claudeEngine.getSessionIdStore().delete(sessionId)
    return this.sessionManager.deleteSession(sessionId)
  }

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
