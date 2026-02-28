import type z from "zod"

// 工具执行上下文
export interface ToolExecutionContext {
  sessionId: string
  userId?: string
  parameters: Record<string, any>
}

// 工具执行结果
export interface ToolExecutionResult {
  success: boolean
  output?: any
  error?: string
}

// 工具权限级别
export enum ToolPermissionLevel {
  PUBLIC = 'public',
  USER = 'user',
  ADMIN = 'admin'
}

// 工具权限配置
export interface ToolPermission {
  level: ToolPermissionLevel
  allowedUsers?: string[] // 用户ID列表，仅对USER级别有效
}

// 工具调用统计
export interface ToolCallStats {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  lastCalledAt?: Date
}

// 工具实例
export interface RegisteredTool {
  name: string
  description: string
  inputSchema: Record<string, z.ZodType>
  execute: (args: Record<string, any>) => Promise<ToolExecutionResult>
}

// 工具调用请求
export interface ToolCallRequest {
  toolName: string
  parameters: Record<string, any>
  sessionId: string
  userId?: string
}

// 工具调用响应
export interface ToolCallResponse {
  toolName: string
  success: boolean
  output?: any
  error?: string
  executionTime: number
}

// 工具验证错误
export interface ToolValidationError {
  field: string
  message: string
}

// 工具验证结果
export interface ToolValidationResult {
  isValid: boolean
  errors: ToolValidationError[]
}
