// src/core/self-iteration/types.ts
// Skill 自迭代系统 — 核心类型定义 (V4)

// ─── Trace 相关 ───

/** 单次 Skill 执行的完整 Trace */
export interface SkillTrace {
  /** 调用时间 */
  startedAt: string
  finishedAt: string
  duration: number // ms

  /** 用户意图 */
  userIntent: string

  /** 内部工具调用步骤 */
  steps: SkillStep[]

  /** 最终输出（不截断） */
  output: string

  status: 'success' | 'failure' | 'partial'
  error?: string
}

/** 单个 tool 调用步骤 */
export interface SkillStep {
  toolName: string
  input: Record<string, unknown>
  output: string
  durationMs: number
  status: 'ok' | 'error'
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
