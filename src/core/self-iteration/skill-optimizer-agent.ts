// src/core/self-iteration/skill-optimizer-agent.ts
// SubAgent 定义 (V5) — 个人 Skill 优化器 + 他人 Skill 分析器
//
// V5 核心变化：
//   - SubAgent 自行读取 trace + session history，不再接收预消化文本
//   - 追加模式写入 best-practices.md / pitfalls.md

import {
  PERSONAL_SKILL_SYSTEM_PROMPT,
  OTHERS_SKILL_SYSTEM_PROMPT,
} from './prompts.js'

/**
 * 个人 Skill 优化 SubAgent
 * 全量修改 skill 目录（除 iteration/traces/）+ 追加 best-practices / pitfalls
 */
export const PERSONAL_OPTIMIZER_AGENT = {
  description:
    'Personal skill optimizer (V5). Reads trace files and session history autonomously, ' +
    'analyzes execution patterns, modifies SKILL.md/scripts/references, and appends to ' +
    'best-practices.md and pitfalls.md. Triggered by nightly CronJob.',

  prompt: PERSONAL_SKILL_SYSTEM_PROMPT,

  tools: ['Read', 'Write', 'Bash', 'Glob'] as string[],
  model: 'sonnet' as const,
}

/**
 * 他人 Skill 分析 SubAgent
 * 只追加写入 iteration/best-practices.md + pitfalls.md
 */
export const OTHERS_ANALYZER_AGENT = {
  description:
    'Others skill analyzer (V5). Reads trace files and session history autonomously, ' +
    'analyzes execution patterns, and appends findings to iteration/best-practices.md ' +
    'and iteration/pitfalls.md only. Triggered by nightly CronJob.',

  prompt: OTHERS_SKILL_SYSTEM_PROMPT,

  tools: ['Read', 'Write', 'Glob'] as string[],
  model: 'sonnet' as const,
}
