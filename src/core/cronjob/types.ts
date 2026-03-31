/**
 * CronJob 能力 - 类型定义
 */

// ==================== 任务定义 ====================

export interface CronJob {
  /** 唯一标识，UUID 自动生成 */
  id: string
  /** 任务名称，如 "每日科技早报" */
  name: string
  /** cron 表达式：标准 5 字段 或 @daily/@hourly/@weekly/@monthly */
  cron: string
  /** 任务类型 */
  taskType: CronTaskType
  /** 任务配置（按 taskType 不同） */
  taskConfig: CronTaskConfig
  /** 执行结果发送到哪个飞书会话（必填） */
  notifyChatId: string
  /** 话题 ID（仅记录，发送时不使用） */
  notifyThreadId?: string
  /** 是否启用 */
  enabled: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 上次执行时间戳 */
  lastRunAt?: number
  /** 上次执行状态 */
  lastRunStatus?: 'success' | 'failed'
}

export type CronTaskType = 'agent_prompt' | 'feishu_notify' | 'custom_script' | 'self_iteration'

// ==================== 任务配置 ====================

export type CronTaskConfig =
  | AgentPromptConfig
  | FeishuNotifyConfig
  | CustomScriptConfig
  | SelfIterationTaskConfig

export interface AgentPromptConfig {
  type: 'agent_prompt'
  /** 让 Agent 执行的 prompt */
  prompt: string
}

export interface FeishuNotifyConfig {
  type: 'feishu_notify'
  /** 静态模板，支持 {{date}} {{time}} {{weekday}} {{datetime}} 变量 */
  messageTemplate?: string
  /** 动态模式：让 Agent 生成消息内容的 prompt */
  agentPrompt?: string
}

export interface CustomScriptConfig {
  type: 'custom_script'
  /** shell 命令 */
  command: string
  /** 超时毫秒数，默认 30000 */
  timeout?: number
}

export interface SelfIterationTaskConfig {
  type: 'self_iteration'
  /** 'all' 扫描所有有 trace 的 Skill，或指定名称列表 */
  skills: 'all' | string[]
}

// ==================== 执行日志 ====================

export interface CronJobLog {
  /** 关联任务 ID */
  jobId: string
  /** 冗余任务名，方便日志可读 */
  jobName: string
  /** 开始时间戳 */
  startedAt: number
  /** 结束时间戳 */
  finishedAt: number
  /** 执行状态 */
  status: 'success' | 'failed' | 'timeout'
  /** 执行结果摘要（截断 500 字符） */
  result?: string
  /** 错误信息 */
  error?: string
}

// ==================== 创建任务的输入 ====================

export type CreateCronJobInput = Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunStatus'>
