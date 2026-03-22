/**
 * StreamingCardRenderer V4.1
 *
 * 流式飞书卡片渲染器 — 基于「Create + Patch」模式实现实时更新。
 *
 * V4.1 变更:
 *   1. [FIX] Sub-Agent 前缀改为 "sub-agent:" (之前是 "agent:")
 *   2. [FIX] 嵌套面板样式优化：去掉背景色和边框，视觉更轻量
 *   3. [NEW] 递归嵌套支持：Sub-Agent 内部如果还有 Sub-Agent，可递归渲染
 *      （飞书 collapsible_panel 最多 5 层嵌套）
 *
 * V4.0 保留:
 *   - Sub-Agent 嵌套折叠面板
 *   - parentToolUseId 归类机制
 *
 * 卡片布局 (含 Sub-Agent):
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [turquoise] ⏳ 思考中...                             │  ← 卡片 header
 *   ├─────────────────────────────────────────────────────┤
 *   │ Show N steps ·                             ▾        │  ← 可折叠步骤面板
 *   │  🧠 thinking 原文                                    │
 *   │  ▸ sub-agent: vision-analyzer              ▾        │  ← Sub-Agent 嵌套面板
 *   │     ✅ tool: Read                                    │     展开可见内部步骤
 *   │     ✅ tool: Bash                                    │
 *   │  ✅ tool: tavily_search                              │
 *   ├─────────────────────────────────────────────────────┤
 *   │ 🧠 当前最新 thinking 原文（实时预览）                    │
 *   ├─────────────────────────────────────────────────────┤
 *   │ 回答正文（markdown）                                  │
 *   └─────────────────────────────────────────────────────┘
 *
 * 飞书限制:
 *   - collapsible_panel: 最多 5 层嵌套, 需 V7.9+
 *   - 卡片 JSON 大小上限: 30KB
 */


// ==================== Types ====================

/** 步骤信息 */
interface StepInfo {
  id: string
  /** 步骤类型 */
  type: 'thinking' | 'tool'
  /** 显示文本（thinking 原文 / 工具名） */
  label: string
  /** 工具动作摘要（仅 tool 类型） */
  actionSummary?: string
  status: 'running' | 'success' | 'error'
  /**
   * 工具分类标签
   * - "skill"：Claude 通过 Skill 工具调用技能
   * - "tool"：SDK 内置工具（Bash/Read/WebSearch 等）或自定义 MCP 工具
   * - "subagent"：Agent 工具（Sub-Agent 调用）
   */
  category?: 'skill' | 'tool' | 'subagent'
  /**
   * Sub-Agent 嵌套：当 category='subagent' 时，
   * 内部工具调用步骤存储在此数组中（支持递归嵌套）。
   */
  childSteps?: StepInfo[]
  /**
   * 关联的 tool_use_id，用于将 Sub-Agent 内部的
   * 工具调用（通过 parentToolUseId）归类到此步骤下。
   * 仅 category='subagent' 时有值。
   */
  toolUseId?: string
}

/** 卡片渲染阶段 */
type CardPhase = 'init' | 'thinking' | 'tool_calling' | 'generating' | 'completed' | 'error' | 'aborted'

/** 卡片内部状态 */
interface CardState {
  phase: CardPhase
  startTime: number
  /** 有序步骤列表（thinking 和 tool 交错排列） */
  steps: StepInfo[]
  /** 面板外实时 thinking 预览（只保留最新一段，下一段完全覆盖） */
  liveThinkingText: string
  contentText: string
  errorMessage?: string
}

/** 飞书客户端接口 (仅需 create + patch) */
export interface FeishuCardClient {
  createInteractiveCard(
    chatId: string,
    cardJson: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<string | null>
  patchInteractiveCard(
    messageId: string,
    cardJson: string,
  ): Promise<boolean>
}

/** 渲染器配置 */
export interface StreamingCardRendererConfig {
  /** Patch 节流间隔 (ms)，默认 800 */
  throttleMs?: number
  /** 回答内容截断长度，默认 Infinity */
  maxContentChars?: number
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
  private stepIdCounter = 0
  private isFallbackMode = false

  private isFirstBuild = true

  /** onAborted 后锁定卡片，拒绝后续 onError/onComplete 覆盖 */
  private isLocked = false

  /** 完成时 @ 的用户 open_id */
  private mentionUserId: string | null = null

  /** 当前正在累积的 thinking 文本 */
  private currentThinkingText = ''
  /** 当前 thinking 步骤的 ID */
  private currentThinkingStepId: string | null = null

  /**
   * tool_use_id → step 映射（递归支持）
   * 用于将 Sub-Agent 内部工具调用通过 parentToolUseId 归类到对应的 Agent 步骤
   */
  private toolUseIdToStep = new Map<string, StepInfo>()

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
      maxContentChars: config?.maxContentChars ?? Infinity,
    }

    this.state = {
      phase: 'init',
      startTime: Date.now(),
      steps: [],
      liveThinkingText: '',
      contentText: '',
    }
  }

  // ==================== Event Methods ====================

  /** 设置完成时要 @ 的用户 */
  setMentionUser(openId: string): void {
    this.mentionUserId = openId
  }

  /** 初始化：立即创建初始卡片 */
  async init(): Promise<void> {
    if (this.messageId || this.isFallbackMode) return
    await this.createInitialCard()
  }

  /** 思考内容增量 */
  async onThinking(thinkingText: string): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    if (this.state.phase === 'init' || this.state.phase === 'thinking') {
      this.state.phase = 'thinking'
    }

    if (!this.currentThinkingStepId) {
      const stepId = `step_${++this.stepIdCounter}`
      this.currentThinkingStepId = stepId
      this.currentThinkingText = ''
      this.state.liveThinkingText = ''
      this.state.steps.push({
        id: stepId,
        type: 'thinking',
        label: '思考中...',
        status: 'running',
      })
    }

    this.currentThinkingText += thinkingText

    const step = this.state.steps.find(s => s.id === this.currentThinkingStepId)
    if (step) {
      step.label = this.currentThinkingText.trim()
    }

    this.state.liveThinkingText = this.currentThinkingText.trim()

    await this.schedulePatch()
  }

  /** 思考结束 */
  async onThinkingStop(): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    if (this.currentThinkingStepId) {
      const step = this.state.steps.find(s => s.id === this.currentThinkingStepId)
      if (step) {
        step.status = 'success'
        step.label = this.currentThinkingText.trim()
      }
      this.currentThinkingStepId = null
      this.currentThinkingText = ''
    }

    await this.schedulePatch()
  }

  /**
   * 工具调用开始
   * @param parentToolUseId - 如果非 null，表示这是 Sub-Agent 内部的工具调用
   * @param toolUseId - 此工具调用的 tool_use_id（用于后续子步骤归类）
   */
  async onToolStart(toolName: string, input?: any, parentToolUseId?: string | null, toolUseId?: string): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    // 如果有未结束的 thinking 步骤，先结束它
    if (this.currentThinkingStepId) {
      const thinkingStep = this.state.steps.find(s => s.id === this.currentThinkingStepId)
      if (thinkingStep) {
        thinkingStep.status = 'success'
        thinkingStep.label = this.currentThinkingText.trim()
      }
      this.currentThinkingStepId = null
      this.currentThinkingText = ''
    }

    this.state.phase = 'tool_calling'

    const { category, displayName } = this.resolveToolInfo(toolName, input)

    const stepId = `step_${++this.stepIdCounter}`
    const newStep: StepInfo = {
      id: stepId,
      type: 'tool',
      label: displayName,
      actionSummary: this.buildToolActionSummary(toolName, input),
      status: 'running',
      category,
    }

    // 如果是 Sub-Agent 工具，初始化 childSteps 并注册到映射表
    if (category === 'subagent' && toolUseId) {
      newStep.childSteps = []
      newStep.toolUseId = toolUseId
      this.toolUseIdToStep.set(toolUseId, newStep)
    }

    // 如果 parentToolUseId 非 null，归类到对应的父 Agent 步骤的 childSteps
    if (parentToolUseId) {
      const parentStep = this.toolUseIdToStep.get(parentToolUseId)
      if (parentStep && parentStep.childSteps) {
        // 递归支持：如果子步骤也是 subagent，它的 toolUseId 也会注册到映射表
        parentStep.childSteps.push(newStep)
        await this.schedulePatch()
        return  // 不添加到顶层 steps
      }
      console.warn(`[card-renderer] ⚠️ parentToolUseId ${parentToolUseId} not found, adding to top level`)
    }

    this.state.steps.push(newStep)
    await this.schedulePatch()
  }

  /**
   * 工具调用结束
   * @param parentToolUseId - 如果非 null，表示这是 Sub-Agent 内部的工具结果
   */
  async onToolEnd(toolName: string, output: any, parentToolUseId?: string | null): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    const { displayName } = this.resolveToolInfo(toolName)
    const resultStatus = typeof output === 'string' && output.startsWith('Error') ? 'error' : 'success'

    // 如果有 parentToolUseId，在对应的 Agent 步骤的 childSteps 中递归查找
    if (parentToolUseId) {
      const parentStep = this.toolUseIdToStep.get(parentToolUseId)
      if (parentStep && parentStep.childSteps) {
        const found = this.findAndMarkStep(parentStep.childSteps, toolName, displayName, resultStatus)
        if (found) {
          await this.schedulePatch()
          return
        }
      }
    }

    // 顶层步骤匹配
    const step = [...this.state.steps]
      .reverse()
      .find(s => s.type === 'tool' && (s.label === toolName || s.label === displayName) && s.status === 'running')
    if (step) {
      step.status = resultStatus
    } else {
      const anyRunning = [...this.state.steps]
        .reverse()
        .find(s => s.type === 'tool' && s.status === 'running')
      if (anyRunning) {
        anyRunning.status = resultStatus
      }
    }

    await this.schedulePatch()
  }

  /** 回答内容增量 */
  async onContentDelta(delta: string): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    if (this.state.phase !== 'generating') {
      this.state.phase = 'generating'
      this.state.liveThinkingText = ''
    }
    this.state.contentText += delta
    await this.schedulePatch()
  }

  /** 完成 */
  async onComplete(): Promise<void> {
    if (this.isLocked) return

    this.markAllRunningSteps(this.state.steps, 'success')

    this.state.phase = 'completed'
    this.state.liveThinkingText = ''
    await this.flushPatch()
  }

  /** 错误 */
  async onError(errorMessage: string): Promise<void> {
    if (this.isLocked) return

    this.markAllRunningSteps(this.state.steps, 'error')

    this.state.phase = 'error'
    this.state.errorMessage = errorMessage
    this.state.liveThinkingText = ''
    await this.flushPatch()
  }

  /** 用户主动中断 */
  async onAborted(): Promise<void> {
    this.markAllRunningSteps(this.state.steps, 'error')

    this.state.phase = 'aborted'
    this.state.liveThinkingText = ''
    await this.flushPatch()
    this.isLocked = true
  }

  /** 获取当前是否降级模式 */
  isFallback(): boolean {
    return this.isFallbackMode
  }

  /** 获取最终完整回答文本 */
  getFullResponseText(): string {
    return this.state.contentText
  }

  /** 检查回答内容是否因卡片大小限制被截断 */
  isContentTruncated(): boolean {
    return this.state.contentText.endsWith('... (已截断)')
  }

  // ==================== Helper ====================

  /** 递归将所有 running 状态的步骤标记为指定状态 */
  private markAllRunningSteps(steps: StepInfo[], status: 'success' | 'error'): void {
    for (const step of steps) {
      if (step.status === 'running') {
        step.status = status
      }
      if (step.childSteps) {
        this.markAllRunningSteps(step.childSteps, status)
      }
    }
  }

  /** 递归查找并标记匹配的 running 步骤 */
  private findAndMarkStep(steps: StepInfo[], toolName: string, displayName: string, status: 'success' | 'error'): boolean {
    // 先在当前层级倒序查找精确匹配
    const step = [...steps]
      .reverse()
      .find(s => s.type === 'tool' && (s.label === toolName || s.label === displayName) && s.status === 'running')
    if (step) {
      step.status = status
      return true
    }
    // 递归到子步骤
    for (const s of steps) {
      if (s.childSteps && this.findAndMarkStep(s.childSteps, toolName, displayName, status)) {
        return true
      }
    }
    // 降级：标记任意 running 的步骤
    const anyRunning = [...steps].reverse().find(s => s.status === 'running')
    if (anyRunning) {
      anyRunning.status = status
      return true
    }
    return false
  }

  // ==================== Card Building ====================

  private buildCard(): object {
    const elements: any[] = []
    const isFinished = this.state.phase === 'completed' || this.state.phase === 'error' || this.state.phase === 'aborted'

    // ====== 1. 步骤面板 ======
    if (this.state.steps.length > 0) {
      elements.push(this.buildStepsPanel(isFinished))
    }

    // ====== 2. 面板外实时 thinking 预览 ======
    if (this.state.liveThinkingText) {
      elements.push({
        tag: 'markdown',
        content: `🧠 ${this.state.liveThinkingText}`,
        text_size: 'normal',
      })
    }

    // ====== 3. 回答内容 ======
    if (this.state.contentText) {
      let content = this.state.contentText
      if (isFinished && this.mentionUserId) {
        content = `<at id=${this.mentionUserId}></at> ` + content
      }
      elements.push({
        tag: 'markdown',
        content,
        text_size: 'normal',
      })
    }

    // ====== 4. 错误信息 ======
    if (this.state.phase === 'error' && this.state.errorMessage) {
      elements.push({
        tag: 'markdown',
        content: `**Error**: ${this.truncate(this.state.errorMessage, 500)}`,
        text_size: 'normal',
      })
    }

    return {
      schema: '2.0',
      header: this.buildCardHeader(),
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

  // -------- 卡片 Header --------

  private buildCardHeader(): object {
    const phaseConfig: Record<CardPhase, { template: string; icon: string; text: string }> = {
      init:         { template: 'turquoise', icon: '⏳', text: '准备中...' },
      thinking:     { template: 'turquoise', icon: '🧠', text: '思考中...' },
      tool_calling: { template: 'turquoise', icon: '🔧', text: '操作中...' },
      generating:   { template: 'turquoise', icon: '✍️', text: '生成中...' },
      completed:    { template: 'green',     icon: '✅', text: '已完成' },
      error:        { template: 'red',       icon: '❌', text: '失败' },
      aborted:      { template: 'grey',      icon: '⏸️', text: '用户已中断' },
    }

    const { template, icon, text } = phaseConfig[this.state.phase]

    let titleContent = `${icon} ${text}`
    if (this.state.phase === 'completed' || this.state.phase === 'error' || this.state.phase === 'aborted') {
      const elapsed = this.formatDuration(Date.now() - this.state.startTime)
      titleContent = `${icon} ${text} · ⏱ ${elapsed}`
    }

    return {
      template,
      title: {
        tag: 'plain_text',
        content: titleContent,
      },
    }
  }

  // -------- 步骤面板 --------

  /** 外层步骤面板 */
  private buildStepsPanel(isFinished: boolean): any {
    const totalSteps = this.countAllSteps(this.state.steps)
    const stepElements = this.buildStepElements(this.state.steps)

    const panelTitle = isFinished
      ? this.buildStepsSummaryTitle(totalSteps)
      : `Show ${totalSteps} steps`

    return {
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
      elements: stepElements,
    }
  }

  /**
   * 递归构建步骤元素列表。
   * Sub-Agent 步骤渲染为嵌套 collapsible_panel，
   * 子步骤中如果还有 Sub-Agent 则继续递归（飞书最多 5 层）。
   */
  private buildStepElements(steps: StepInfo[]): any[] {
    const elements: any[] = []

    for (const step of steps) {
      if (step.category === 'subagent' && step.childSteps && step.childSteps.length > 0) {
        elements.push(this.buildSubAgentPanel(step))
      } else {
        elements.push(this.buildStepLine(step))
      }
    }

    return elements
  }

  /**
   * 构建 Sub-Agent 嵌套折叠面板。
   * 无背景色无边框，视觉轻量。
   * 子元素通过 buildStepElements 递归构建，支持多层嵌套。
   */
  private buildSubAgentPanel(step: StepInfo): any {
    const icon = this.getStepIcon(step)
    const childCount = step.childSteps?.length ?? 0
    const statusSuffix = step.status === 'running'
      ? ` · ${childCount} steps running...`
      : ` · ${childCount} steps`

    // 递归构建子元素（支持子 Sub-Agent 继续嵌套）
    const childElements = this.buildStepElements(step.childSteps ?? [])

    return {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: `${icon}  sub-agent: ${step.label}${statusSuffix}`,
        },
        icon_position: 'right',
        icon_expanded_angle: 90,
      },
      border: { color: 'purple', corner_radius: '6px' },
      background_color: 'purple-50',
      elements: childElements.length > 0 ? childElements : [{
        tag: 'markdown',
        content: '⏳ 等待执行...',
        text_size: 'notation',
      }],
    }
  }

  /** 递归统计所有步骤数（包含子步骤） */
  private countAllSteps(steps: StepInfo[]): number {
    let count = 0
    for (const step of steps) {
      count++
      if (step.childSteps) {
        count += this.countAllSteps(step.childSteps)
      }
    }
    return count
  }

  /** 构建面板 header 摘要标题 */
  private buildStepsSummaryTitle(totalSteps: number): string {
    let thinkingCount = 0
    let toolCount = 0
    let skillCount = 0
    let subagentCount = 0
    let errorCount = 0
    this.collectStepStats(this.state.steps, {
      onThinking: () => thinkingCount++,
      onTool: () => toolCount++,
      onSkill: () => skillCount++,
      onSubagent: () => subagentCount++,
      onError: () => errorCount++,
    })

    const parts: string[] = []
    if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`)
    if (toolCount > 0) parts.push(`${toolCount} tool`)
    if (skillCount > 0) parts.push(`${skillCount} skill`)
    if (subagentCount > 0) parts.push(`${subagentCount} sub-agent`)

    let summary = `${totalSteps} steps · ${parts.join(', ')}`
    if (errorCount > 0) {
      summary += ` · ${errorCount} error`
    }

    return summary
  }

  /** 递归收集步骤统计信息 */
  private collectStepStats(steps: StepInfo[], callbacks: {
    onThinking: () => void
    onTool: () => void
    onSkill: () => void
    onSubagent: () => void
    onError: () => void
  }): void {
    for (const step of steps) {
      if (step.status === 'error') callbacks.onError()
      if (step.type === 'thinking') callbacks.onThinking()
      else if (step.category === 'skill') callbacks.onSkill()
      else if (step.category === 'subagent') callbacks.onSubagent()
      else callbacks.onTool()

      if (step.childSteps) {
        this.collectStepStats(step.childSteps, callbacks)
      }
    }
  }

  /** 构建单个步骤行 */
  private buildStepLine(step: StepInfo): any {
    const icon = this.getStepIcon(step)
    let text: string

    if (step.type === 'thinking') {
      text = `${icon}  ${step.label}`
    } else {
      const prefix = step.category === 'skill' ? 'skill' : step.category === 'subagent' ? 'sub-agent' : 'tool'
      text = `${icon}  ${prefix}: ${step.label}`
      if (step.actionSummary) {
        text += `\n　　${step.actionSummary}`
      }
    }

    return {
      tag: 'markdown',
      content: text,
      text_size: 'notation',
    }
  }

  private getStepIcon(step: StepInfo): string {
    if (step.status === 'running') {
      return step.type === 'thinking' ? '🧠' : '⏳'
    }
    if (step.status === 'error') return '❌'
    return step.type === 'thinking' ? '🧠' : '✅'
  }

  // ==================== Tool Info Resolution ====================

  private resolveToolInfo(toolName: string, input?: any): { category: 'skill' | 'tool' | 'subagent'; displayName: string } {
    if (toolName === 'Skill') {
      let skillName = ''
      if (input && typeof input === 'object') {
        skillName = input.skill_name || input.name || input.skill || ''
      }
      if (typeof input === 'string') {
        skillName = input
      }
      return {
        category: 'skill',
        displayName: skillName || 'Skill',
      }
    }

    if (toolName === 'Agent') {
      let agentName = ''
      if (input && typeof input === 'object') {
        agentName = input.subagent_type || input.agent_type || input.type || input.name || ''
      }
      return {
        category: 'subagent',
        displayName: agentName || 'Agent',
      }
    }

    if (toolName.includes('__')) {
      const shortName = toolName.split('__').pop()!
      return { category: 'tool', displayName: shortName }
    }

    return { category: 'tool', displayName: toolName }
  }

  // ==================== Patch Scheduling ====================

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
        this.isFirstBuild = false
      } else {
        this.isFallbackMode = true
      }
    } catch (error) {
      this.isFallbackMode = true
    }
  }

  private static readonly CARD_BYTE_LIMIT = 29 * 1024

  private getByteLength(str: string): number {
    return Buffer.byteLength(str, 'utf8')
  }

  /** 执行 Patch 更新 */
  private async executePatch(): Promise<void> {
    if (!this.messageId || this.isFallbackMode) return

    try {
      let cardJson = JSON.stringify(this.buildCard())
      let byteSize = this.getByteLength(cardJson)

      if (byteSize > StreamingCardRenderer.CARD_BYTE_LIMIT) {

        // 第 1 步：截断 liveThinkingText
        if (this.state.liveThinkingText.length > 500) {
          this.state.liveThinkingText = this.state.liveThinkingText.slice(0, 500) + '...'
          cardJson = JSON.stringify(this.buildCard())
          byteSize = this.getByteLength(cardJson)
        }

        // 第 2 步：截断过长的 thinking 步骤
        if (byteSize > StreamingCardRenderer.CARD_BYTE_LIMIT) {
          let needRebuild = false
          this.truncateThinkingSteps(this.state.steps, 300, () => needRebuild = true)
          if (needRebuild) {
            cardJson = JSON.stringify(this.buildCard())
            byteSize = this.getByteLength(cardJson)
          }
        }

        // 第 3 步：二分法缩减正文
        if (byteSize > StreamingCardRenderer.CARD_BYTE_LIMIT) {
          const originalContent = this.state.contentText
          let lo = 0, hi = originalContent.length
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2)
            this.state.contentText = originalContent.slice(0, mid) + '\n... (已截断)'
            const testJson = JSON.stringify(this.buildCard())
            if (this.getByteLength(testJson) <= StreamingCardRenderer.CARD_BYTE_LIMIT) {
              lo = mid
            } else {
              hi = mid - 1
            }
          }
          this.state.contentText = lo < originalContent.length
            ? originalContent.slice(0, lo) + '\n... (已截断)'
            : originalContent
          cardJson = JSON.stringify(this.buildCard())
        }
      }

      await this.client.patchInteractiveCard(this.messageId, cardJson)
      this.hasPendingPatch = false
    } catch (error) {
    }
  }

  /** 递归截断过长的 thinking 步骤 label */
  private truncateThinkingSteps(steps: StepInfo[], maxLen: number, onTruncated: () => void): void {
    for (const step of steps) {
      if (step.type === 'thinking' && step.label.length > maxLen) {
        step.label = step.label.slice(0, maxLen) + '...'
        onTruncated()
      }
      if (step.childSteps) {
        this.truncateThinkingSteps(step.childSteps, maxLen, onTruncated)
      }
    }
  }

  // ==================== Utility ====================

  private truncate(text: string, maxLen: number): string {
    if (!text) return ''
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '\n... (已截断)'
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const remainSec = seconds % 60
    return `${minutes}m ${remainSec.toFixed(0)}s`
  }

  private buildToolActionSummary(toolName: string, input?: any): string {
    if (!input) return ''

    if (toolName === 'Skill') {
      if (typeof input === 'object' && input !== null) {
        const detail = input.prompt || input.instruction || input.description || ''
        if (detail && typeof detail === 'string') {
          return detail.length > 50 ? detail.slice(0, 47) + '...' : detail
        }
      }
      return ''
    }

    if (typeof input === 'object' && input !== null) {
      const query = input.query || input.q || input.search || input.keyword || input.command || input.url || input.path
      if (query && typeof query === 'string') {
        const display = query.length > 50 ? query.slice(0, 47) + '...' : query
        return display
      }
    }

    const inputStr = typeof input === 'string' ? input : ''
    if (inputStr && inputStr.length < 60) {
      return inputStr
    }

    return ''
  }
}
