// src/core/self-iteration/types.ts
// Skill 自迭代系统 — 核心类型定义 (V3)

// ─── Trace 相关 ───

/** 单次 Skill 执行的完整 Trace */
export interface SkillTrace {
  traceId: string
  skillName: string
  sessionId: string
  startedAt: string
  finishedAt: string
  duration: number // ms

  input: {
    userIntent: string
    matchedPattern?: string
  }

  steps: SkillStep[]

  output: {
    result: string
    tokensUsed?: number
  }

  status: 'success' | 'failure' | 'partial'
  error?: string
}

/** 单个 tool 调用步骤 */
export interface SkillStep {
  stepIndex: number
  toolName: string
  input: Record<string, unknown>
  output: {
    summary: string
    durationMs: number
    status: 'ok' | 'error'
    error?: string
  }
}

// ─── 分析结果 ───

/** SubAgent 单次分析输出 */
export interface AnalysisResult {
  bestPractices: string
  pitfalls: string
  shouldOptimize: boolean
  newContent?: string       // 仅当 shouldOptimize=true 时提供
  analysis: string          // 本次分析摘要
  diffRatio?: number        // 新 SKILL.md 与旧的差异比
  confidence?: number       // 信心度 0-1
}

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

// ─── 配置 ───

/** 自迭代配置 */
export interface SelfIterationConfig {
  enabled: boolean
  safety: {
    maxSkillMdDiffRatio: number
    maxOptimizationsPerDay: number
  }
}
