// src/core/self-iteration/index.ts
// Barrel export — Skill 自迭代系统 (V3)

export { TraceCollector } from './trace-collector.js'
export { SkillOptimizer } from './optimizer.js'
export { IterationChecker } from './iteration-checker.js'
export { SKILL_OPTIMIZER_AGENT } from './skill-optimizer-agent.js'
export { DEFAULT_CONFIG, SKILLS_DIR } from './config.js'

export type {
  SkillTrace,
  SkillStep,
  AnalysisResult,
  NightlyReport,
  NightlySkillReport,
  SelfIterationConfig,
} from './types.js'
