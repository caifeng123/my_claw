/**
 * StreamingCardRenderer V2.0
 *
 * 流式飞书卡片渲染器 — 基于「Create + Patch」模式实现实时更新。
 *
 * V2 全新卡片设计（扁平状态栏方案）:
 *   ┌─────────────────────────────────────────────────────┐
 *   │ 🧠 思考中... / 🔧 tavily_search / 📝 生成中...      │  ← 动态状态栏
 *   ├─────────────────────────────────────────────────────┤
 *   │ > 正在搜索 "xxx" 的相关信息...                       │  ← 当前动作摘要
 *   ├─────────────────────────────────────────────────────┤
 *   │ ⚙️ 执行过程 (collapsible, 默认折叠)                 │  ← 详情面板
 *   │  ├─ 🧠 思考内容                                     │
 *   │  ├─ ✅ tool_1 (0.8s)                                │
 *   │  └─ ✅ tool_2 (1.2s)                                │
 *   ├─────────────────────────────────────────────────────┤
 *   │ 回答正文（markdown）                                  │  ← 回答内容
 *   ├─────────────────────────────────────────────────────┤
 *   │ ⏱ 12.3s │ 📥 2.1k │ 📤 856 │ 🔧 3 步              │  ← 底部统计
 *   └─────────────────────────────────────────────────────┘
 *
 * 设计原则:
 *   - 状态栏始终可见，无需展开即知当前进度
 *   - 详情面板默认折叠，按需查看
 *   - 底部统计仅完成/错误后展示
 *
 * 飞书限制:
 *   - im.v1.message.patch: 5 QPS, 14天窗口, 仅 interactive 类型
 *   - 卡片 JSON 大小上限: 30KB
 *   - collapsible_panel: 最多 5 层嵌套, 需 V7.9+
 *   - Schema V2 不支持 note 标签
 */

import type { TokenUsageStats } from '../../core/agent/types/agent.js'

// ==================== Types ====================

/** 工具调用信息 */
interface ToolCallInfo {
  id: string
  name: string
  input?: any
  output?: any
  status: 'pending' | 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
}

/** 卡片渲染阶段 */
type CardPhase = 'init' | 'thinking' | 'tool_calling' | 'generating' | 'completed' | 'error'

/** 卡片内部状态 */
interface CardState {
  phase: CardPhase
  startTime: number
  thinkingContent: string
  thinkingStartTime?: number
  thinkingEndTime?: number
  toolCalls: ToolCallInfo[]
  /** 当前正在执行的动作描述（展示在状态栏下方） */
  currentAction: string
  contentText: string
  usage?: TokenUsageStats
  errorMessage?: string
  /** 总步骤数（thinking + tool calls） */
  stepCount: number
}

/** 飞书客户端接口 (仅需 create + patch) */
export interface FeishuCardClient {
  createInteractiveCard(
    chatId: string,
    cardJson: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<string | null>  // 返回 message_id
  patchInteractiveCard(
    messageId: string,
    cardJson: string,
  ): Promise<boolean>
}

/** 渲染器配置 */
export interface StreamingCardRendererConfig {
  /** Patch 节流间隔 (ms)，默认 800 */
  throttleMs?: number
  /** 思考内容最大字符数，默认 2000 */
  maxThinkingChars?: number
  /** 工具输入截断长度，默认 500 */
  maxToolInputChars?: number
  /** 工具输出截断长度，默认 800 */
  maxToolOutputChars?: number
  /** 回答内容截断长度，默认 3500 (卡片30KB上限) */
  maxContentChars?: number
  /** 最多显示几个工具调用子面板（超出后合并为摘要行），默认 8 */
  maxToolPanels?: number
}

// ==================== Status Config ====================

/** 各阶段对应的状态栏配置 */
const PHASE_STATUS: Record<CardPhase, { icon: string; label: string }> = {
  init:         { icon: '⏳', label: '准备中...' },
  thinking:     { icon: '🧠', label: '思考中...' },
  tool_calling: { icon: '🔧', label: '工具调用中' },
  generating:   { icon: '📝', label: '生成中...' },
  completed:    { icon: '✅', label: '已完成' },
  error:        { icon: '❌', label: '执行出错' },
}

// ==================== Renderer ====================

export class StreamingCardRenderer {
  private client: FeishuCardClient
  private chatId: string
  private replyMessageId?: string
  private threadId?: string
  private messageId: string | null = null
  private config: Required<StreamingCardRendererConfig>

  private state: CardState
  private patchTimer: ReturnType<typeof setTimeout> | null = null
  private hasPendingPatch = false
  private toolIdCounter = 0
  private isFallbackMode = false

  constructor(
    client: FeishuCardClient,
    chatId: string,
    replyMessageId?: string,
    threadId?: string,
    config?: StreamingCardRendererConfig,
  ) {
    this.client = client
    this.chatId = chatId
    this.replyMessageId = replyMessageId
    this.threadId = threadId

    this.config = {
      throttleMs: config?.throttleMs ?? 800,
      maxThinkingChars: config?.maxThinkingChars ?? 2000,
      maxToolInputChars: config?.maxToolInputChars ?? 500,
      maxToolOutputChars: config?.maxToolOutputChars ?? 800,
      maxContentChars: config?.maxContentChars ?? 3500,
      maxToolPanels: config?.maxToolPanels ?? 8,
    }

    this.state = {
      phase: 'init',
      startTime: Date.now(),
      thinkingContent: '',
      toolCalls: [],
      currentAction: '',
      contentText: '',
      stepCount: 0,
    }
  }

  // ==================== Event Methods ====================

  /** 初始化：立即创建初始卡片 */
  async init(): Promise<void> {
    if (this.messageId || this.isFallbackMode) return
    await this.createInitialCard()
  }

  /** 思考内容增量 */
  async onThinking(thinkingText: string): Promise<void> {
    if (this.isFallbackMode) return

    if (this.state.phase === 'init' || this.state.phase === 'thinking') {
      if (this.state.phase === 'init') {
        this.state.stepCount++
      }
      this.state.phase = 'thinking'
      if (!this.state.thinkingStartTime) {
        this.state.thinkingStartTime = Date.now()
      }
    }
    this.state.thinkingContent += thinkingText
    // 从思考内容中提取摘要作为当前动作
    this.state.currentAction = this.extractThinkingSummary(this.state.thinkingContent)
    await this.schedulePatch()
  }

  /** 思考结束 */
  async onThinkingStop(): Promise<void> {
    if (this.isFallbackMode) return
    this.state.thinkingEndTime = Date.now()
    await this.schedulePatch()
  }

  /** 工具调用开始 */
  async onToolStart(toolName: string, input?: any): Promise<void> {
    if (this.isFallbackMode) return

    if (this.state.phase !== 'tool_calling') {
      if (!this.state.thinkingEndTime && this.state.thinkingStartTime) {
        this.state.thinkingEndTime = Date.now()
      }
      this.state.phase = 'tool_calling'
    }

    this.state.stepCount++

    const toolCall: ToolCallInfo = {
      id: `tool_${++this.toolIdCounter}`,
      name: toolName,
      input,
      status: 'running',
      startTime: Date.now(),
    }
    this.state.toolCalls.push(toolCall)

    // 更新当前动作描述
    this.state.currentAction = this.buildToolActionSummary(toolName, input)
    await this.schedulePatch()
  }

  /** 工具调用结束 */
  async onToolEnd(toolName: string, output: any): Promise<void> {
    if (this.isFallbackMode) return

    const tool = [...this.state.toolCalls]
      .reverse()
      .find(t => t.name === toolName && t.status === 'running')
    if (tool) {
      tool.status = typeof output === 'string' && output.startsWith('Error') ? 'error' : 'success'
      tool.endTime = Date.now()
      tool.output = output
    }

    // 检查是否还有正在运行的工具
    const runningTool = this.state.toolCalls.find(t => t.status === 'running')
    if (runningTool) {
      this.state.currentAction = this.buildToolActionSummary(runningTool.name, runningTool.input)
    } else {
      this.state.currentAction = ''
    }

    await this.schedulePatch()
  }

  /** 回答内容增量 */
  async onContentDelta(delta: string): Promise<void> {
    if (this.isFallbackMode) return

    if (this.state.phase !== 'generating') {
      this.state.phase = 'generating'
      this.state.currentAction = ''
    }
    this.state.contentText += delta
    await this.schedulePatch()
  }

  /** 用量更新 */
  async onUsageUpdate(usage: TokenUsageStats): Promise<void> {
    this.state.usage = usage
  }

  /** 完成 */
  async onComplete(usage?: TokenUsageStats): Promise<void> {
    this.state.phase = 'completed'
    this.state.currentAction = ''
    if (usage) this.state.usage = usage
    await this.flushPatch()
  }

  /** 错误 */
  async onError(errorMessage: string): Promise<void> {
    this.state.phase = 'error'
    this.state.errorMessage = errorMessage
    this.state.currentAction = ''
    await this.flushPatch()
  }

  /** 获取当前是否降级模式 */
  isFallback(): boolean {
    return this.isFallbackMode
  }

  /** 获取最终完整回答文本 */
  getFullResponseText(): string {
    return this.state.contentText
  }

  // ==================== Card Building ====================

  private buildCard(): object {
    const elements: any[] = []
    const elapsed = this.getElapsed()
    const isFinished = this.state.phase === 'completed' || this.state.phase === 'error'

    // ====== 1. 动态状态栏 ======
    elements.push(this.buildStatusBar())

    // ====== 2. 当前动作摘要（进行中时展示） ======
    if (!isFinished && this.state.currentAction) {
      elements.push({
        tag: 'markdown',
        content: `> ${this.state.currentAction}`,
        text_size: 'notation',
      })
    }

    // ====== 3. 执行过程详情面板（有内容时展示，默认折叠） ======
    const processElements = this.buildProcessElements()
    if (processElements.length > 0) {
      const toolCount = this.state.toolCalls.length
      const successCount = this.state.toolCalls.filter(t => t.status === 'success').length
      const errorCount = this.state.toolCalls.filter(t => t.status === 'error').length
      const runningCount = this.state.toolCalls.filter(t => t.status === 'running').length

      let panelTitle = '⚙️ 执行过程'
      if (isFinished) {
        const parts: string[] = []
        if (this.state.thinkingContent) parts.push('思考')
        if (toolCount > 0) {
          let toolSummary = `${toolCount} 次工具调用`
          if (errorCount > 0) toolSummary += ` (${errorCount} 失败)`
          parts.push(toolSummary)
        }
        panelTitle = `⚙️ ${parts.join(' + ')}`
      } else {
        if (runningCount > 0) {
          panelTitle = `⚙️ 执行中 (${successCount}/${toolCount})`
        }
      }

      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        background_color: 'grey',
        header: {
          title: {
            tag: 'plain_text',
            content: panelTitle,
          },
          icon_position: 'right',
          icon_expanded_angle: 90,
        },
        border: { color: 'grey', corner_radius: '8px' },
        elements: processElements,
      })
    }

    // ====== 4. 回答内容 ======
    if (this.state.contentText) {
      elements.push({
        tag: 'markdown',
        content: this.truncate(this.state.contentText, this.config.maxContentChars),
        text_size: 'normal',
      })
    }

    // ====== 5. 错误信息 ======
    if (this.state.phase === 'error' && this.state.errorMessage) {
      elements.push({
        tag: 'markdown',
        content: `**Error**: ${this.truncate(this.state.errorMessage, 500)}`,
        text_size: 'normal',
      })
    }

    // ====== 6. 底部统计栏（仅完成/错误后展示） ======
    if (isFinished) {
      elements.push(this.buildStatsFooter(elapsed))
    }

    return {
      schema: '2.0',
      config: {
        update_multi: true,
        style: {
          text_size: {
            normal_v2: {
              default: 'normal',
              pc: 'normal',
              mobile: 'heading',
            },
          },
        },
      },
      body: {
        direction: 'vertical',
        padding: '12px 12px 12px 12px',
        elements,
      },
    }
  }

  // -------- 1. 状态栏 --------

  /** 构建动态状态栏 — 始终显示当前阶段 */
  private buildStatusBar(): any {
    const { icon, label } = PHASE_STATUS[this.state.phase]
    const elapsed = this.getElapsed()
    const isFinished = this.state.phase === 'completed' || this.state.phase === 'error'

    // 进行中：显示阶段图标 + 标签 + 当前工具名
    // 已完成：显示 ✅ 已完成
    let statusText = `${icon} **${label}**`

    if (!isFinished) {
      // 如果在工具调用中，显示当前工具名
      if (this.state.phase === 'tool_calling') {
        const runningTool = this.state.toolCalls.find(t => t.status === 'running')
        if (runningTool) {
          statusText = `🔧 **${runningTool.name}**`
        }
      }
      // 附加运行时间
      statusText += `  \`${this.formatDuration(elapsed)}\``
    }

    return {
      tag: 'markdown',
      content: statusText,
      text_size: 'heading',
    }
  }

  // -------- 3. 执行过程面板内容 --------

  /** 构建执行过程详情（面板内的子元素） */
  private buildProcessElements(): any[] {
    const elements: any[] = []

    // 3.1 思考内容
    if (this.state.thinkingContent) {
      const thinkingDuration = this.state.thinkingEndTime && this.state.thinkingStartTime
        ? this.state.thinkingEndTime - this.state.thinkingStartTime
        : (this.state.thinkingStartTime ? Date.now() - this.state.thinkingStartTime : 0)

      const isThinking = this.state.phase === 'thinking'
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        background_color: 'grey',
        header: {
          title: {
            tag: 'plain_text',
            content: isThinking
              ? '🧠 思考中...'
              : `🧠 思考过程 (${this.formatDuration(thinkingDuration)})`,
          },
          icon_position: 'right',
          icon_expanded_angle: 90,
        },
        border: { color: 'grey', corner_radius: '8px' },
        elements: [{
          tag: 'markdown',
          content: this.truncate(this.state.thinkingContent, this.config.maxThinkingChars),
        }],
      })
    }

    // 3.2 工具调用列表
    if (this.state.toolCalls.length > 0) {
      const toolElements = this.buildToolElements()
      elements.push(...toolElements)
    }

    return elements
  }

  /** 构建工具调用列表 */
  private buildToolElements(): any[] {
    const tools = this.state.toolCalls

    // 工具数量过多时，合并早期工具为摘要行
    if (tools.length > this.config.maxToolPanels) {
      const collapsed = tools.slice(0, -(this.config.maxToolPanels - 2))
      const recent = tools.slice(-(this.config.maxToolPanels - 2))
      const successCount = collapsed.filter(t => t.status === 'success').length
      const errorCount = collapsed.filter(t => t.status === 'error').length
      const parts: string[] = []
      if (successCount > 0) parts.push(`✅${successCount}`)
      if (errorCount > 0) parts.push(`❌${errorCount}`)

      return [
        {
          tag: 'markdown',
          content: `... 其他 ${collapsed.length} 次调用 (${parts.join(' ')})`,
          text_size: 'notation',
        },
        ...recent.map(t => this.buildSingleToolPanel(t)),
      ]
    }

    return tools.map(t => this.buildSingleToolPanel(t))
  }

  /** 构建单个工具调用面板 */
  private buildSingleToolPanel(tool: ToolCallInfo): any {
    const icon = this.getToolStatusIcon(tool.status)
    const duration = tool.endTime
      ? ` (${this.formatDuration(tool.endTime - tool.startTime)})`
      : ''
    const isRunning = tool.status === 'running'

    const innerElements: any[] = []

    // 输出结果优先
    if (tool.output && !isRunning) {
      const outputStr = typeof tool.output === 'string'
        ? tool.output
        : JSON.stringify(tool.output, null, 2)
      innerElements.push({
        tag: 'markdown',
        content: `**输出**\n${this.truncate(outputStr, this.config.maxToolOutputChars)}`,
      })
    }

    // 输入参数
    if (tool.input) {
      const inputStr = typeof tool.input === 'string'
        ? tool.input
        : JSON.stringify(tool.input, null, 2)
      innerElements.push({
        tag: 'markdown',
        content: `**输入**\n\`\`\`json\n${this.truncate(inputStr, this.config.maxToolInputChars)}\n\`\`\``,
      })
    }

    if (innerElements.length === 0) {
      innerElements.push({
        tag: 'markdown',
        content: isRunning ? '⏳ 执行中...' : '(无详情)',
      })
    }

    return {
      tag: 'collapsible_panel',
      expanded: false,
      background_color: tool.status === 'error' ? 'red' : 'grey',
      header: {
        title: {
          tag: 'plain_text',
          content: `${icon} ${tool.name}${duration}`,
        },
        icon_position: 'right',
        icon_expanded_angle: 90,
      },
      border: { color: tool.status === 'error' ? 'red' : 'grey', corner_radius: '8px' },
      elements: innerElements,
    }
  }

  // -------- 6. 底部统计栏 --------

  /** 构建底部统计（运行时间 | 输入token | 输出token | 步骤数） */
  private buildStatsFooter(elapsed: number): any {
    const parts: string[] = []

    // 运行时间
    parts.push(`⏱ ${this.formatDuration(elapsed)}`)

    // Token 统计
    if (this.state.usage) {
      const u = this.state.usage
      if (u.inputTokens > 0 || u.outputTokens > 0) {
        parts.push(`📥 ${this.formatTokenCount(u.inputTokens)}`)
        parts.push(`📤 ${this.formatTokenCount(u.outputTokens)}`)
      }
      if (u.totalCostUsd > 0) {
        parts.push(`💰 $${u.totalCostUsd.toFixed(4)}`)
      }
    }

    // 步骤数
    if (this.state.stepCount > 0) {
      parts.push(`🔧 ${this.state.stepCount} 步`)
    }

    return {
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [{
          tag: 'markdown',
          content: parts.join('  |  '),
          text_size: 'notation',
        }],
      }],
    }
  }

  // ==================== Patch Scheduling ====================

  /** 节流调度 Patch */
  private async schedulePatch(): Promise<void> {
    this.hasPendingPatch = true

    if (!this.messageId) {
      await this.createInitialCard()
      return
    }

    if (this.patchTimer) return

    this.patchTimer = setTimeout(async () => {
      this.patchTimer = null
      if (this.hasPendingPatch) {
        await this.executePatch()
      }
    }, this.config.throttleMs)
  }

  /** 立即 flush 所有待更新 */
  private async flushPatch(): Promise<void> {
    if (this.patchTimer) {
      clearTimeout(this.patchTimer)
      this.patchTimer = null
    }

    if (!this.messageId) {
      await this.createInitialCard()
    }

    await this.executePatch()
  }

  /** 创建初始卡片 */
  private async createInitialCard(): Promise<void> {
    if (this.isFallbackMode) return

    try {
      const cardJson = JSON.stringify(this.buildCard())
      const msgId = await this.client.createInteractiveCard(
        this.chatId,
        cardJson,
        this.replyMessageId,
        this.threadId,
      )
      if (msgId) {
        this.messageId = msgId
        this.hasPendingPatch = false
        console.log(`📋 流式卡片已创建: ${msgId}`)
      } else {
        console.warn('⚠️ 创建卡片未返回 message_id，降级为普通消息')
        this.isFallbackMode = true
      }
    } catch (error) {
      console.error('❌ 创建初始卡片失败，降级为普通消息:', error)
      this.isFallbackMode = true
    }
  }

  /** 执行 Patch 更新 */
  private async executePatch(): Promise<void> {
    if (!this.messageId || this.isFallbackMode) return

    try {
      const cardJson = JSON.stringify(this.buildCard())
      if (cardJson.length > 28000) {
        console.warn(`⚠️ 卡片 JSON 接近上限 (${cardJson.length} bytes)，截断内容`)
        this.state.thinkingContent = this.truncate(this.state.thinkingContent, 500)
        this.state.contentText = this.truncate(this.state.contentText, 2000)
        const trimmedJson = JSON.stringify(this.buildCard())
        await this.client.patchInteractiveCard(this.messageId, trimmedJson)
      } else {
        await this.client.patchInteractiveCard(this.messageId, cardJson)
      }
      this.hasPendingPatch = false
    } catch (error) {
      console.error('❌ Patch 卡片失败:', error)
    }
  }

  // ==================== Utility ====================

  private getElapsed(): number {
    return Date.now() - this.state.startTime
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${minutes}m${secs}s`
  }

  private formatTokenCount(count: number): string {
    if (count < 1000) return `${count}`
    return `${(count / 1000).toFixed(1)}k`
  }

  private truncate(text: string, maxLen: number): string {
    if (!text) return ''
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '\n... (已截断)'
  }

  private getToolStatusIcon(status: ToolCallInfo['status']): string {
    switch (status) {
      case 'running': return '⏳'
      case 'success': return '✅'
      case 'error':   return '❌'
      case 'pending':  return '⬚'
    }
  }

  /** 从思考内容中提取最后一句话作为摘要 */
  private extractThinkingSummary(text: string): string {
    if (!text) return ''
    // 取最后非空行
    const lines = text.trim().split('\n').filter(l => l.trim())
    const lastLine = lines[lines.length - 1] || ''
    // 截断到合理长度
    if (lastLine.length > 60) {
      return lastLine.slice(0, 57) + '...'
    }
    return lastLine
  }

  /** 构建工具调用的动作摘要 */
  private buildToolActionSummary(toolName: string, input?: any): string {
    if (!input) return `正在调用 ${toolName}...`

    // 从 input 中提取关键参数作为描述
    const inputStr = typeof input === 'string' ? input : ''
    if (inputStr && inputStr.length < 60) {
      return `${toolName}: ${inputStr}`
    }

    if (typeof input === 'object' && input !== null) {
      // 提取常见关键参数
      const query = input.query || input.q || input.search || input.keyword || input.command || input.url || input.path
      if (query && typeof query === 'string') {
        const display = query.length > 50 ? query.slice(0, 47) + '...' : query
        return `${toolName}: ${display}`
      }
    }

    return `正在调用 ${toolName}...`
  }
}
