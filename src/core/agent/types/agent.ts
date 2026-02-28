import type { SDKMessage, SDKToolUseSummaryMessage } from '@anthropic-ai/claude-agent-sdk'

// Agent 配置类型
export interface AgentConfig {
  apiKey: string
  model?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

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
  usage?: {
    inputTokens: number
    outputTokens: number
  }
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
  onContentStart?: () => void
  onContentDelta?: (delta: string) => void
  onContentStop?: () => void
  onToolUseStart?: (toolName: string) => void
  onToolUseStop?: (toolName: string, result: any) => void
  onError?: (error: string) => void
}