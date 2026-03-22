import type { SDKMessage, SDKToolUseSummaryMessage } from '@anthropic-ai/claude-agent-sdk'

// 会话配置
export interface SessionConfig {
  sessionId: string
  userId?: string
  maxContextLength?: number
  enableMemory?: boolean
}

// 工具定义
export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, any>
  execute: (params: any) => Promise<any>
}

// 会话状态
export interface SessionState {
  sessionId: string
  userId?: string
  messages: SDKMessage[]
  createdAt: Date
  updatedAt: Date
  contextLength: number
}

// Agent 响应类型
export interface AgentResponse {
  content: string
  toolCalls?: SDKToolUseSummaryMessage[]
}

// 流式响应事件
export type StreamEvent =
  | { type: 'content_start' }
  | { type: 'content_delta'; delta: string }
  | { type: 'content_stop' }
  | { type: 'tool_use_start'; toolName: string }
  | { type: 'tool_use_stop'; toolName: string; result: any }
  | { type: 'error'; error: string }

// 工具调用结果
export interface ToolCallResult {
  toolName: string
  input: any
  output: any
  success: boolean
  error?: string
}

// 事件处理器
export interface EventHandlers {
  onContentStart?: () => Promise<void>
  onContentDelta?: (delta: string) => Promise<void>
  onContentStop?: () => Promise<void>
  onThinkingDelta?: (thinkingText: string) => Promise<void>
  onThinkingStop?: () => Promise<void>
  /**
   * 工具调用开始
   * @param toolName - 工具名称
   * @param input - 工具输入参数
   * @param parentToolUseId - 如果非 null，表示这是 Sub-Agent 内部的工具调用，
   *   值为父 Agent tool 的 tool_use_id，用于在 UI 中做嵌套展示
   * @param toolUseId - 此 tool_use 块的 ID，仅在 toolName='Agent' 时有意义，
   *   后续 Sub-Agent 内部调用会引用此 ID 作为 parentToolUseId
   */
  onToolUseStart?: (toolName: string, input?: any, parentToolUseId?: string | null, toolUseId?: string) => Promise<void>
  /**
   * 工具调用结束
   * @param parentToolUseId - 同上
   * @param toolUseId - 此 tool_use 块的 ID（与 onToolUseStart 中的 toolUseId 一致）
   */
  onToolUseStop?: (toolName: string, result: any, parentToolUseId?: string | null, toolUseId?: string) => Promise<void>
  onError?: (error: string) => Promise<void>
}
