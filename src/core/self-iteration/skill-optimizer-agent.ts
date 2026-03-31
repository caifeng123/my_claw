// src/core/self-iteration/skill-optimizer-agent.ts
// SubAgent 定义 — 个人 Skill 优化器 + 他人 Skill 分析器
//
// 由 CronJob 夜间批量调用，通过不同 prompt 引导 AI 走不同路径：
//   - 个人 Skill → 全量优化（SKILL.md / scripts / references，不动 iteration/）
//   - 他人 Skill → 只写 iteration/best-practices.md + pitfalls.md

import {
  PERSONAL_SKILL_SYSTEM_PROMPT,
  OTHERS_SKILL_SYSTEM_PROMPT,
} from './prompts.js'

/**
 * 个人 Skill 优化 SubAgent
 * 全量修改 skill 目录（除 iteration/）
 */
export const PERSONAL_OPTIMIZER_AGENT = {
  description:
    'Personal skill optimizer. Analyzes execution traces and directly modifies ' +
    'SKILL.md, scripts, references to improve the skill. ' +
    'Does NOT modify iteration/ directory. Internal use — triggered by nightly CronJob.',

  prompt: PERSONAL_SKILL_SYSTEM_PROMPT,

  tools: ['Read', 'Write', 'Bash', 'Glob'] as string[],
  model: 'sonnet' as const,
}

/**
 * 他人 Skill 分析 SubAgent
 * 只写 iteration/best-practices.md + pitfalls.md
 */
export const OTHERS_ANALYZER_AGENT = {
  description:
    'Others skill analyzer. Analyzes execution traces and updates only ' +
    'iteration/best-practices.md and iteration/pitfalls.md. ' +
    'Does NOT modify SKILL.md, scripts, or references. Internal use — triggered by nightly CronJob.',

  prompt: OTHERS_SKILL_SYSTEM_PROMPT,

  tools: ['Read', 'Write', 'Glob'] as string[],
  model: 'sonnet' as const,
}
