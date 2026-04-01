// src/core/self-iteration/index.ts
// Barrel export — Skill 自迭代系统 (V5)

// ─── Trace 采集 ───
export { TraceCollector } from './trace-collector.js'

// ─── 迭代检查（CronJob 入口） ───
export { IterationChecker } from './iteration-checker.js'

// ─── SubAgent 定义 ───
export { PERSONAL_OPTIMIZER_AGENT, OTHERS_ANALYZER_AGENT } from './skill-optimizer-agent.js'

// ─── Hook 拦截器（仅 PreToolUse） ───
export {
  getSkillInterceptorConfig,
  skillPreToolUseHook,
} from './skill-interceptor.js'

// ─── Metadata 解析 ───
export { parseFrontmatter, isPersonalSkill } from './metadata-parser.js'

// ─── 实践注入 ───
export { appendPracticeSections, hasPracticeSections } from './practice-injector.js'

// ─── Prompts ───
export { PERSONAL_SKILL_SYSTEM_PROMPT, OTHERS_SKILL_SYSTEM_PROMPT } from './prompts.js'

// ─── 配置 & 类型 ───
export { DEFAULT_CONFIG, SKILLS_DIR } from './config.js'

export type {
  // V5 新类型
  TimelineEvent,
  TimelineEventType,
  TurnTrace,
  SkillView,
  // 兼容旧类型
  SkillTrace,
  SkillStep,
  NightlyReport,
  NightlySkillReport,
  SelfIterationConfig,
} from './types.js'

export type { SkillFrontmatter } from './metadata-parser.js'
export type { SkillInterceptorConfig } from './skill-interceptor.js'
