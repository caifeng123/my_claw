// src/core/self-iteration/types.ts
// Skill 自迭代系统 — 核心类型定义 (V5)
//
// V5 核心变化：
//   - 采集层记录全量 timeline，不做归属判断
//   - 读取时按 skill_start 位置 slice，按需获取各 Skill 视角

// ─── Timeline 相关 ───

/** 单个 timeline 事件的类型 */
export type TimelineEventType =
  | 'skill_start'   // Skill 工具被调用
  | 'skill_ready'   // Skill tool_result 返回（SKILL.md 注入完成）
  | 'tool_start'    // 普通工具调用开始
  | 'tool_end'      // 普通工具调用结束
  | 'turn_end'      // 整个 turn 结束

/** 单个 timeline 事件 */
export interface TimelineEvent {
  /** 时间戳 (ms) */
  ts: number
  /** 事件类型 */
  type: TimelineEventType
  /** Skill 名称（仅 skill_start/skill_ready） */
  skill?: string
  /** 工具名称（仅 tool_start/tool_end） */
  tool?: string
  /** SDK 分配的 toolUseId */
  toolUseId?: string
  /** SDK 分配的 parentToolUseId（SubAgent 场景下非 null） */
  parentToolUseId?: string | null
  /** 工具输入（仅 tool_start/skill_start） */
  input?: Record<string, unknown>
  /** 工具输出（仅 tool_end/skill_ready/turn_end） */
  output?: string
  /** 执行状态（仅 tool_end） */
  status?: 'ok' | 'error'
}

/** 一个完整 turn 的 trace 记录（写入 JSONL 的单行） */
export interface TurnTrace {
  /** 会话 ID */
  sessionId: string
  /** 用户意图（原始消息） */
  userIntent: string
  /** turn 开始时间 */
  startedAt: string
  /** turn 结束时间 */
  finishedAt: string
  /** 总耗时 (ms) */
  duration: number
  /** 全量事件流 */
  timeline: TimelineEvent[]
  /** 最终输出 */
  output: string
  /** 整体状态 */
  status: 'success' | 'failure' | 'partial'
}

// ─── Skill 视角（读取时 slice 生成，不持久化） ───

/** 从 timeline 中 slice 出的单个 Skill 执行视角 */
export interface SkillView {
  skillName: string
  startedAt: number
  finishedAt: number
  duration: number
  /** 该 Skill 视角下的 timeline 切片 */
  events: TimelineEvent[]
  /** 从 events 中提取的工具调用步骤（便于分析） */
  steps: SkillStep[]
  status: 'success' | 'failure' | 'partial'
}

/** 单个 tool 调用步骤（从 timeline 配对 tool_start/tool_end 生成） */
export interface SkillStep {
  toolName: string
  input: Record<string, unknown>
  output: string
  durationMs: number
  status: 'ok' | 'error'
}

// ─── 兼容旧类型（供 iteration-checker 使用） ───

/** @deprecated 使用 TurnTrace + sliceForSkill 替代 */
export interface SkillTrace {
  /** 关联的 sessionId，用于反查对话上下文 */
  sessionId: string
  startedAt: string
  finishedAt: string
  duration: number
  userIntent: string
  steps: SkillStep[]
  output: string
  status: 'success' | 'failure' | 'partial'
  error?: string
}

// ─── 分析结果 ───

/** 每夜批量执行报告 */
export interface NightlyReport {
  runAt: string
  skills: NightlySkillReport[]
}

export interface NightlySkillReport {
  skillName: string
  tracesAnalyzed: number
  action: 'analyzed' | 'optimized' | 'skipped' | 'error'
  reason: string
}

// ─── 配置类型 ───

export interface SelfIterationConfig {
  enabled: boolean
  safety: {
    maxSkillMdDiffRatio: number
    maxOptimizationsPerDay: number
  }
}
