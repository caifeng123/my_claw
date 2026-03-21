/**
 * StreamingCardRenderer V3.9
 *
 * 流式飞书卡片渲染器 — 基于「Create + Patch」模式实现实时更新。
 *
 * V3.8 变更:
 *   1. [FIX] 状态标题迁移至卡片 header：使用飞书卡片原生 header，
 *      配合 template 颜色区分不同阶段（turquoise=进行中, green=已完成, red=错误）
 *   2. [FIX] 面板标题摘要：完成后面板 header 标题变为摘要统计信息，
 *      面板始终保留 collapsible_panel 可折叠交互
 *
 * V3.7 保留:
 *   - 步骤标注：区分 skill / tool 类型，格式为 "skill: xxx" 或 "tool: xxx"
 *
 * 卡片布局:
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [turquoise] ⏳ 思考中...                             │  ← 卡片 header（带颜色模板）
 *   │            (完成/失败时标题含耗时)                        │
 *   ├─────────────────────────────────────────────────────┤
 *   │ Show N steps ·                             ▾        │  ← 可折叠步骤面板
 *   │  🧠 thinking 原文                                    │     完成后标题变为摘要
 *   │  ✅ skill: deep-research                             │
 *   │  ✅ tool: tavily_search                              │
 *   │  ✅ tool: Bash                                       │
 *   ├─────────────────────────────────────────────────────┤
 *   │ 🧠 当前最新 thinking 原文（实时预览，每段覆盖上一段）      │  ← 面板外实时预览
 *   ├─────────────────────────────────────────────────────┤
 *   │ 回答正文（markdown）                                  │  ← 回答内容
 *   └─────────────────────────────────────────────────────┘
 *
 * header 颜色映射:
 *   init / thinking / tool_calling / generating → turquoise (进行中)
 *   completed                                   → green     (成功)
 *   error                                       → red       (错误)
 *   aborted                                     → grey      (中断)
 *
 * 面板策略 (V3.9):
 *   运行中  → collapsible_panel (expanded=false)，header 显示 "Show N steps"
 *   完成后  → collapsible_panel (expanded=false)，header 变为摘要统计
 *
 * 飞书限制:
 *   - im.v1.message.patch: 5 QPS, 14天窗口, 仅 interactive 类型
 *   - 卡片 JSON 大小上限: 30KB
 *   - collapsible_panel: 最多 5 层嵌套, 需 V7.9+
 *   - Schema V2 不支持 note 标签
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
   * V3.7: 工具分类标签 —— "skill" 或 "tool"
   * 仅 type='tool' 时有值。
   * - "skill"：Claude 通过 Skill 工具调用 .claude/skills/ 下的技能
   * - "tool"：SDK 内置工具（Bash/Read/WebSearch 等）或自定义 MCP 工具
   */
  category?: 'skill' | 'tool'
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

  /**
   * 标记当前是否为首次创建卡片。
   * 仅用于追踪生命周期，不影响渲染逻辑。
   */
  private isFirstBuild = true

  /** onAborted 后锁定卡片，拒绝后续 onError/onComplete 覆盖 */
  private isLocked = false

  /** 完成时 @ 的用户 open_id */
  private mentionUserId: string | null = null

  /** 当前正在累积的 thinking 文本 */
  private currentThinkingText = ''
  /** 当前 thinking 步骤的 ID */
  private currentThinkingStepId: string | null = null

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

    // 如果当前没有活跃的 thinking 步骤，创建一个新的
    // 同时清空 liveThinkingText —— 每段新 thinking 完全覆盖上一段
    if (!this.currentThinkingStepId) {
      const stepId = `step_${++this.stepIdCounter}`
      this.currentThinkingStepId = stepId
      this.currentThinkingText = ''
      this.state.liveThinkingText = ''  // 新一段 thinking，覆盖上一段预览
      this.state.steps.push({
        id: stepId,
        type: 'thinking',
        label: '思考中...',
        status: 'running',
      })
    }

    this.currentThinkingText += thinkingText

    // 更新步骤面板内的 label
    const step = this.state.steps.find(s => s.id === this.currentThinkingStepId)
    if (step) {
      step.label = this.currentThinkingText.trim()
    }

    // 同步更新面板外的实时预览
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
      // 注意：这里不清 liveThinkingText，保留预览直到下一段 thinking 覆盖或开始生成回答
    }

    await this.schedulePatch()
  }

  /** 工具调用开始 */
  async onToolStart(toolName: string, input?: any): Promise<void> {
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

    // V3.7: 解析工具分类和显示名
    const { category, displayName } = this.resolveToolInfo(toolName, input)

    const stepId = `step_${++this.stepIdCounter}`
    this.state.steps.push({
      id: stepId,
      type: 'tool',
      label: displayName,
      actionSummary: this.buildToolActionSummary(toolName, input),
      status: 'running',
      category,
    })

    await this.schedulePatch()
  }

  /** 工具调用结束 */
  async onToolEnd(toolName: string, output: any): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    console.log('[card-renderer] ✅ onToolEnd:', toolName)
    // V3.7: onToolEnd 的 toolName 匹配逻辑需兼容新的 displayName
    const { displayName } = this.resolveToolInfo(toolName)

    const step = [...this.state.steps]
      .reverse()
      .find(s => s.type === 'tool' && (s.label === toolName || s.label === displayName) && s.status === 'running')
    if (step) {
      step.status = typeof output === 'string' && output.startsWith('Error') ? 'error' : 'success'
    } else {
      const anyRunning = [...this.state.steps]
        .reverse()
        .find(s => s.type === 'tool' && s.status === 'running')
      if (anyRunning) {
        anyRunning.status = typeof output === 'string' && output.startsWith('Error') ? 'error' : 'success'
      }
    }

    await this.schedulePatch()
  }

  /** 回答内容增量 */
  async onContentDelta(delta: string): Promise<void> {
    if (this.isFallbackMode || this.isLocked) return

    if (this.state.phase !== 'generating') {
      this.state.phase = 'generating'
      // 开始生成回答 → 清除 thinking 预览
      this.state.liveThinkingText = ''
    }
    this.state.contentText += delta
    await this.schedulePatch()
  }

  /** 完成 */
  async onComplete(): Promise<void> {
    if (this.isLocked) return
    for (const step of this.state.steps) {
      if (step.status === 'running') {
        step.status = 'success'
      }
    }

    this.state.phase = 'completed'
    this.state.liveThinkingText = ''  // 完成时清除预览
    await this.flushPatch()
  }

  /** 错误 */
  async onError(errorMessage: string): Promise<void> {
    if (this.isLocked) return
    for (const step of this.state.steps) {
      if (step.status === 'running') {
        step.status = 'error'
      }
    }

    this.state.phase = 'error'
    this.state.errorMessage = errorMessage
    this.state.liveThinkingText = ''  // 出错时清除预览
    await this.flushPatch()
  }

  /** 用户主动中断 */
  async onAborted(): Promise<void> {
    for (const step of this.state.steps) {
      if (step.status === 'running') {
        step.status = 'error'
      }
    }

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

    // ====== 3. 回答内容（完成时在开头 @ 提问者）======
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

  /**
   * V3.8: 构建卡片原生 header，取代之前 body 中的 markdown 状态标题。
   *
   * 颜色映射:
   *   init / thinking / tool_calling / generating → turquoise (进行中)
   *   completed                                   → green     (成功)
   *   error                                       → red       (错误)
 *   aborted                                     → grey      (中断)
   */
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

    // 已完成/失败时，耗时直接拼在大标题后面
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

  /**
   * 构建步骤区域。
   *
   * V3.9 策略：始终使用 collapsible_panel，完成后将 header 标题替换为摘要信息。
   *   运行中 → header: "Show N steps"
   *   完成后 → header: "N steps · X thinking, Y tool, Z skill"
   *
   * expanded 始终为 false（飞书 patch 无法强制覆盖客户端展开状态，
   * 但初始创建时 false 可保证默认收起）。
   */
  private buildStepsPanel(isFinished: boolean): any {
    const totalSteps = this.state.steps.length
    const stepLines = this.state.steps.map(step => this.buildStepLine(step))

    // 面板标题：运行中用简单计数，完成后用摘要统计
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
      elements: stepLines,
    }
  }

  /**
   * V3.9: 构建面板 header 摘要标题（纯文本字符串）。
   * 完成后显示为 "5 steps · 2 thinking, 2 tool, 1 skill"
   * 有 error 时追加 " · 1 error"
   */
  private buildStepsSummaryTitle(totalSteps: number): string {
    let thinkingCount = 0
    let toolCount = 0
    let skillCount = 0
    let errorCount = 0
    for (const step of this.state.steps) {
      if (step.status === 'error') errorCount++
      if (step.type === 'thinking') thinkingCount++
      else if (step.category === 'skill') skillCount++
      else toolCount++
    }

    const parts: string[] = []
    if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`)
    if (toolCount > 0) parts.push(`${toolCount} tool`)
    if (skillCount > 0) parts.push(`${skillCount} skill`)

    let summary = `${totalSteps} steps · ${parts.join(', ')}`
    if (errorCount > 0) {
      summary += ` · ${errorCount} error`
    }

    return summary
  }

  /**
   * 构建单个步骤行。
   * V3.7: tool 类型步骤标注 "skill: xxx" 或 "tool: xxx"
   */
  private buildStepLine(step: StepInfo): any {
    const icon = this.getStepIcon(step)
    let text: string

    if (step.type === 'thinking') {
      text = `${icon}  ${step.label}`
    } else {
      // V3.7: 使用 category 标注类型
      const prefix = step.category === 'skill' ? 'skill' : 'tool'
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

  /**
   * V3.7: 解析工具分类（skill vs tool）和显示名称。
   *
   * 分类规则:
   *   1. toolName === 'Skill' → category='skill'，从 input 中提取 skill 名称作为 displayName
   *   2. toolName 含 'mcp__' 前缀 → category='tool'，去前缀后作为 displayName
   *   3. 其他 → category='tool'，直接用 toolName 作为 displayName
   */
  private resolveToolInfo(toolName: string, input?: any): { category: 'skill' | 'tool'; displayName: string } {
    // Case 1: SDK 内置 Skill 工具 → 从 input 提取具体 skill 名
    if (toolName === 'Skill') {
      let skillName = ''
      if (input && typeof input === 'object') {
        // Claude Agent SDK 的 Skill 工具，input 中通常包含 skill_name / name / skill 字段
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

    // Case 2: 自定义 MCP 工具（mcp__cf-claw-tools__xxx）→ 去前缀
    if (toolName.includes('__')) {
      const shortName = toolName.split('__').pop()!
      return { category: 'tool', displayName: shortName }
    }

    // Case 3: SDK 内置工具（Bash, Read, WebSearch 等）→ 直接使用
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
        // 首次创建完成
        this.isFirstBuild = false
      } else {
        this.isFallbackMode = true
      }
    } catch (error) {
      this.isFallbackMode = true
    }
  }

  // 飞书卡片 30KB 限制
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
          for (const step of this.state.steps) {
            if (step.type === 'thinking' && step.label.length > 300) {
              step.label = step.label.slice(0, 300) + '...'
              needRebuild = true
            }
          }
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

  // ==================== Utility ====================

  private truncate(text: string, maxLen: number): string {
    if (!text) return ''
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '\n... (已截断)'
  }

  /** 格式化运行时间：自动选择合适单位 */
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

    // V3.7: Skill 工具的 actionSummary 不重复显示 skill 名（已在 displayName 中体现）
    if (toolName === 'Skill') {
      // 尝试提取 prompt / instruction 等有意义的字段
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
