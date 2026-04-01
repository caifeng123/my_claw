// src/core/self-iteration/iteration-checker.ts
// 迭代检查器 (V5) — 薄 checker，只负责发现 + 派发 SubAgent
//
// V5 核心变化：
//   - 不再预读 trace / 格式化文本 / 拼接上下文
//   - 只做：发现有 trace 的 Skill → 判断类型 → 把路径传给 SubAgent
//   - SubAgent 自行读取 trace 文件 + session history + SKILL.md

import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClaudeEngine } from '../agent/engine/claude-engine.js'
import type {
  NightlyReport,
  NightlySkillReport,
} from './types.js'
import { isPersonalSkill } from './metadata-parser.js'
import {
  PERSONAL_SKILL_SYSTEM_PROMPT,
  OTHERS_SKILL_SYSTEM_PROMPT,
} from './prompts.js'
import { SKILLS_DIR } from './config.js'
import { SESSIONS_ROOT } from '../../utils/paths.js'

export class IterationChecker {
  private claudeEngine: ClaudeEngine

  constructor(claudeEngine: ClaudeEngine) {
    this.claudeEngine = claudeEngine
  }

  // ─── 入口 ───

  async runNightly(skillFilter: 'all' | string[]): Promise<NightlyReport> {
    const report: NightlyReport = {
      runAt: new Date().toISOString(),
      skills: [],
    }

    const skills = skillFilter === 'all'
      ? this.discoverSkillsWithTraces()
      : skillFilter

    console.log(`🌙 [IterationChecker] Nightly run: ${skills.length} skill(s) to check`)

    for (const skillName of skills) {
      const skillReport = await this.processSkill(skillName)
      report.skills.push(skillReport)
    }

    const analyzed = report.skills.filter(s => s.action === 'analyzed').length
    const optimized = report.skills.filter(s => s.action === 'optimized').length
    const skipped = report.skills.filter(s => s.action === 'skipped').length

    console.log(
      `🌙 [IterationChecker] Nightly complete: ` +
      `${optimized} optimized, ${analyzed} analyzed, ${skipped} skipped`,
    )

    return report
  }

  // ─── 单个 Skill 处理 ───

  private async processSkill(skillName: string): Promise<NightlySkillReport> {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const skillDir = join(SKILLS_DIR, skillName)
      const traceFile = join(skillDir, 'iteration', 'traces', `${today}.jsonl`)

      // 无 trace 则跳过
      if (!existsSync(traceFile)) {
        return { skillName, tracesAnalyzed: 0, action: 'skipped', reason: 'No traces today' }
      }

      // 判断 Skill 类型
      const skillMd = this.loadSkillMd(skillName)
      const personal = isPersonalSkill(skillMd)
      const typeLabel = personal ? 'personal' : 'others'

      console.log(`📊 [IterationChecker] "${skillName}": type=${typeLabel}, dispatching to SubAgent`)

      // 构建 SubAgent 的 userPrompt — 只传路径和元数据
      const userPrompt = [
        `skillName: ${skillName}`,
        `skillDir: ${skillDir}`,
        `traceFile: ${traceFile}`,
        `sessionsDir: ${SESSIONS_ROOT}`,
        `skillType: ${typeLabel}`,
        `date: ${today}`,
      ].join('\n')

      const systemPrompt = personal
        ? PERSONAL_SKILL_SYSTEM_PROMPT
        : OTHERS_SKILL_SYSTEM_PROMPT

      // SubAgent 自行读文件、分析、写入
      await this.claudeEngine.sendMessage(userPrompt, systemPrompt)

      return {
        skillName,
        tracesAnalyzed: -1, // SubAgent 自行计数，checker 不再关心
        action: personal ? 'optimized' : 'analyzed',
        reason: `${typeLabel} skill dispatched to SubAgent`,
      }
    } catch (err) {
      console.error(`[IterationChecker] Error processing "${skillName}":`, err)
      return {
        skillName,
        tracesAnalyzed: 0,
        action: 'error',
        reason: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // ─── SKILL.md 加载（仅用于判断 personal/others） ───

  private loadSkillMd(skillName: string): string {
    
    const candidates = [
      join(SKILLS_DIR, skillName, 'SKILL.md'),
      join(SKILLS_DIR, skillName, 'skill.md'),
      join(SKILLS_DIR, `${skillName}.md`),
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          return readFileSync(p, 'utf-8')
        } catch {
          continue
        }
      }
    }

    return '(SKILL.md not found)'
  }

  // ─── Skill 发现 ───

  private discoverSkillsWithTraces(): string[] {
    if (!existsSync(SKILLS_DIR)) return []

    const today = new Date().toISOString().slice(0, 10)

    try {
      return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .filter(e => {
          const todayTrace = join(SKILLS_DIR, e.name, 'iteration', 'traces', `${today}.jsonl`)
          return existsSync(todayTrace)
        })
        .map(e => e.name)
    } catch {
      return []
    }
  }
}
