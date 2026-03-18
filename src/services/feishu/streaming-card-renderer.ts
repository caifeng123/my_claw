/**
 * StreamingCardRenderer V3.6
 *
 * 流式飞书卡片渲染器 — 基于「Create + Patch」模式实现实时更新。
 *
 * V3.6 卡片布局:
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ⏳ 思考中...  ⏱ 12.3s                                │  ← 状态标题（带 icon）
 *   ├─────────────────────────────────────────────────────┤
 *   │ Show N steps ·                             ▾        │  ← 可折叠步骤面板
 *   │  🧠 thinking 原文                                    │
 *   │  ✅ tool_name                                       │
 *   │  ...                                                │
 *   ├─────────────────────────────────────────────────────┤
 *   │ 🧠 当前最新 thinking 原文（实时预览，每段覆盖上一段）      │  ← 面板外实时预览
 *   ├─────────────────────────────────────────────────────┤
 *   │ 回答正文（markdown）                                  │  ← 回答内容
 *   └─────────────────────────────────────────────────────┘
 *
 * 状态标题映射:
 *   init        → ⏳ 准备中...
 *   thinking    → 🧠 思考中...
 *   tool_calling→ 🔧 操作中...
 *   generating  → ✍️ 生成中...
 *   completed   → ✅ 已完成
 *   error       → ❌ 失败
 *
 * 面板 expanded 三态策略:
 *   - 初始创建：expanded = false（默认收起）
 *   - 中间 patch：不传 expanded 字段 → 飞书保持用户手动展开/收起状态
 *   - 完成/出错：expanded = false（确保收起）
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
}

/** 卡片渲染阶段 */
type CardPhase = 'init' | 'thinking' | 'tool_calling' | 'generating' | 'completed' | 'error'

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
   * 用于 expanded 三态策略：首次创建时 expanded=false，之后不传该字段。
   */
  private isFirstBuild = true

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

  /** 初始化：立即创建初始卡片 */
  async init(): Promise<void> {
    if (this.messageId || this.isFallbackMode) return
    await this.createInitialCard()
  }

  /** 思考内容增量 */
  async onThinking(thinkingText: string): Promise<void> {
    if (this.isFallbackMode) return

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
    if (this.isFallbackMode) return

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
    if (this.isFallbackMode) return

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

    const stepId = `step_${++this.stepIdCounter}`
    this.state.steps.push({
      id: stepId,
      type: 'tool',
      label: toolName,
      actionSummary: this.buildToolActionSummary(toolName, input),
      status: 'running',
    })

    await this.schedulePatch()
  }

  /** 工具调用结束 */
  async onToolEnd(toolName: string, output: any): Promise<void> {
    if (this.isFallbackMode) return

    const step = [...this.state.steps]
      .reverse()
      .find(s => s.type === 'tool' && s.label === toolName && s.status === 'running')
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
    if (this.isFallbackMode) return

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
    const isFinished = this.state.phase === 'completed' || this.state.phase === 'error'

    // ====== 0. 状态标题 ======
    elements.push(this.buildStatusHeader())

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
      elements.push({
        tag: 'markdown',
        content: this.state.contentText,
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

  // -------- 状态标题 --------

  /** 根据当前 phase 返回顶部状态标题元素 */
  private buildStatusHeader(): any {
    const statusMap: Record<CardPhase, { icon: string; text: string }> = {
      init:         { icon: '⏳', text: '准备中...' },
      thinking:     { icon: '🧠', text: '思考中...' },
      tool_calling: { icon: '🔧', text: '操作中...' },
      generating:   { icon: '✍️', text: '生成中...' },
      completed:    { icon: '✅', text: '已完成' },
      error:        { icon: '❌', text: '失败' },
    }

    const { icon, text } = statusMap[this.state.phase]

    // 已完成状态追加运行时间
    let display = `**${icon} ${text}**`
    if (this.state.phase === 'completed') {
      const elapsed = this.formatDuration(Date.now() - this.state.startTime)
      display = `**${icon} ${text} · ⏱ ${elapsed}**`
    }

    return {
      tag: 'markdown',
      content: display,
      text_size: 'heading',
    }
  }

  // -------- 步骤面板 --------

  /**
   * 构建可折叠步骤面板。
   *
   * expanded 三态策略：
   *   1. 首次创建（isFirstBuild=true）→ expanded=false，默认收起
   *   2. 中间 patch（isFirstBuild=false, isFinished=false）→ 不传 expanded，
   *      飞书保持用户手动展开/收起的状态不被覆盖
   *   3. 完成/出错（isFinished=true）→ expanded=false，确保最终收起
   */
  private buildStepsPanel(isFinished: boolean): any {
    const totalSteps = this.state.steps.length
    const stepLines = this.state.steps.map(step => this.buildStepLine(step))

    // 面板标题：仅显示步骤数（运行时间已移至顶部状态标题）
    const panelTitle = `Show ${totalSteps} steps`

    const panel: any = {
      tag: 'collapsible_panel',
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

    // 仅在首次创建和最终完成时显式设置 expanded
    // 中间 patch 不传此字段 → 飞书保持用户手动操作的状态
    if (this.isFirstBuild || isFinished) {
      panel.expanded = false
    }

    return panel
  }

  private buildStepLine(step: StepInfo): any {
    const icon = this.getStepIcon(step)
    let text: string

    if (step.type === 'thinking') {
      text = `${icon}  ${step.label}`
    } else {
      text = `${icon}  ${step.label}`
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
        // 首次创建完成，后续 patch 不再设置 expanded
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
