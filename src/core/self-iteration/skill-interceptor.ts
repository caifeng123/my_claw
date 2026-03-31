// src/core/self-iteration/skill-interceptor.ts
// Skill 调用拦截器 — 仅 PreToolUse Hook
//
// 职责单一：他人 Skill → 幂等追加 "## 调用实践" section
// Trace 采集完全由 agent/index.ts 的 EventTap 负责，不在此处处理

import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPersonalSkill } from './metadata-parser.js'
import { appendPracticeSections, hasPracticeSections } from './practice-injector.js'
import { SKILLS_DIR } from './config.js'

// ════════════════════════════════════════
// PreToolUse Hook — 他人 Skill 注入调用实践
// ════════════════════════════════════════

export const skillPreToolUseHook: HookCallback = async (
  input: HookInput,
  _toolUseId: string | undefined,
  _options: { signal: AbortSignal },
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== 'PreToolUse') return {}

  const pre = input as PreToolUseHookInput

  // Sub-Agent 内部调用直接放行
  if (pre.agent_id) return {}

  const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>
  const skillName = extractSkillName(pre.tool_name, toolInput)
  if (!skillName) return {}

  const skillMdPath = resolveSkillMdPath(skillName)
  if (!skillMdPath) return {}

  let content: string
  try {
    content = readFileSync(skillMdPath, 'utf-8')
  } catch {
    return {}
  }

  // ★ 只有他人 Skill 才需要追加调用实践 section
  if (!isPersonalSkill(content) && !hasPracticeSections(content)) {
    const { appended } = appendPracticeSections(skillMdPath, content)
    if (appended) {
      console.log(`📝 [SkillInterceptor] Appended practice sections to "${skillName}"`)
    }
  }

  return {} // allow
}

// ════════════════════════════════════════
// 导出 Hook 配置（供 claude-engine 合并）
// ════════════════════════════════════════

export interface SkillInterceptorConfig {
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: HookCallback[] }>
  }
}

export function getSkillInterceptorConfig(): SkillInterceptorConfig {
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Skill', hooks: [skillPreToolUseHook] },
      ],
    },
  }
}

// ════════════════════════════════════════
// Helpers
// ════════════════════════════════════════

function extractSkillName(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (toolInput.skill && typeof toolInput.skill === 'string') return toolInput.skill
  if (toolInput.name && typeof toolInput.name === 'string') return toolInput.name
  if (toolName !== 'Skill' && toolName.startsWith('skill-')) {
    return toolName.replace('skill-', '')
  }
  return null
}

function resolveSkillMdPath(skillName: string): string | null {
  const candidates = [
    join(SKILLS_DIR, skillName, 'SKILL.md'),
    join(SKILLS_DIR, skillName, 'skill.md'),
    join(SKILLS_DIR, `${skillName}.md`),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}
