// src/core/self-iteration/iteration-checker.ts
// 迭代检查器 (V4) — 由 CronJob 每天 0 点调用 runNightly()
//
// V4 核心变化：
//   - 通过 metadata.personal 区分个人 / 他人 Skill
//   - 个人 Skill：AI 全量优化（SKILL.md / scripts / references，不动 iteration/）
//   - 他人 Skill：AI 只写 iteration/best-practices.md + pitfalls.md
//   - 不再用代码解析 JSON / apply patch，完全交给 AI 自主操作文件
//   - 通过当天 trace 文件是否存在来判断是否需要分析（无需 .last_analyzed）

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClaudeEngine } from '../agent/engine/claude-engine.js'
import type {
  SkillTrace,
  NightlyReport,
  NightlySkillReport,
} from './types.js'
import { isPersonalSkill } from './metadata-parser.js'
import {
  PERSONAL_SKILL_SYSTEM_PROMPT,
  OTHERS_SKILL_SYSTEM_PROMPT,
} from './prompts.js'
import { SKILLS_DIR } from './config.js'

export class IterationChecker {
  private claudeEngine: ClaudeEngine

  constructor(claudeEngine: ClaudeEngine) {
    this.claudeEngine = claudeEngine
  }

  // ─── 入口 ───

  /**
   * 每夜批量分析入口 — 由 CronJob 调用
   */
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
      // Phase 1: 加载当天的 trace（CronJob 0 点跑，取"今天"日期的文件）
      const today = new Date().toISOString().slice(0, 10)
      const traces = this.loadTracesForDate(skillName, today)

      if (traces.length === 0) {
        return { skillName, tracesAnalyzed: 0, action: 'skipped', reason: 'No traces today' }
      }

      // Phase 2: 判断 Skill 类型
      const skillMd = this.loadSkillMd(skillName)
      const personal = isPersonalSkill(skillMd)
      const skillDir = join(SKILLS_DIR, skillName)

      const typeLabel = personal ? 'personal' : 'others'
      console.log(`📊 [IterationChecker] "${skillName}": ${traces.length} traces, type=${typeLabel}`)

      // Phase 3: 构建 trace 摘要 + 选择对应 prompt，交给 AI
      const traceSummary = this.formatTraces(traces)

      const systemPrompt = personal
        ? PERSONAL_SKILL_SYSTEM_PROMPT
        : OTHERS_SKILL_SYSTEM_PROMPT

      const userPrompt = [
        `skill 目录: ${skillDir}`,
        `skill 名称: ${skillName}`,
        `trace 数量: ${traces.length}`,
        `  成功: ${traces.filter(t => t.status === 'success').length}`,
        `  失败: ${traces.filter(t => t.status === 'failure').length}`,
        `  部分: ${traces.filter(t => t.status === 'partial').length}`,
        '',
        '<traces>',
        traceSummary,
        '</traces>',
      ].join('\n')

      // AI 自主读写文件，不再解析返回的 JSON
      await this.claudeEngine.sendMessage(userPrompt, systemPrompt)

      return {
        skillName,
        tracesAnalyzed: traces.length,
        action: personal ? 'optimized' : 'analyzed',
        reason: `${typeLabel} skill processed by AI (${traces.length} traces)`,
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

  // ─── Trace 加载 ───

  /**
   * 加载指定日期的 trace 文件
   * trace 文件路径: .claude/skills/{name}/iteration/traces/{date}.jsonl
   */
  private loadTracesForDate(skillName: string, date: string): SkillTrace[] {
    const filePath = join(SKILLS_DIR, skillName, 'iteration', 'traces', `${date}.jsonl`)
    if (!existsSync(filePath)) return []

    const traces: SkillTrace[] = []
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          traces.push(JSON.parse(line) as SkillTrace)
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }

    return traces
  }

  // ─── Trace 格式化 ───

  /**
   * 将 traces 格式化为 AI 可读的文本摘要
   */
  private formatTraces(traces: SkillTrace[]): string {
    // 限制数量，避免 prompt 过长
    const maxTraces = 50
    const recent = traces.slice(-maxTraces)

    return recent
      .map(t => {
        const steps = t.steps
          .map(s => `    - ${s.toolName}: ${s.status} (${s.durationMs}ms)${s.status === 'error' ? ` error=${s.output.slice(0, 200)}` : ''}`)
          .join('\n')

        return [
          `status=${t.status}, duration=${t.duration}ms, time=${t.startedAt}`,
          `  intent: ${t.userIntent}`,
          `  steps:`,
          steps || '    (no steps recorded)',
          `  output: ${t.output.slice(0, 500)}`,
          t.error ? `  error: ${t.error}` : '',
        ].filter(Boolean).join('\n')
      })
      .join('\n\n')
  }

  // ─── SKILL.md 加载 ───

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

  /**
   * 扫描所有有当天 trace 文件的 Skill
   */
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
