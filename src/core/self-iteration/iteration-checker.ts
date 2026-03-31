// src/core/self-iteration/iteration-checker.ts
// 迭代检查器 (V3) — 由 CronJob 每天 0 点调用 runNightly()
//
// 三阶段流程：
//   Phase 1: 收集未分析的 trace 文件（按天）
//   Phase 2: 调用 SubAgent 提炼知识 + 判断是否优化
//   Phase 3: 如需优化，安全检查后写入 SKILL.md

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClaudeEngine } from '../agent/engine/claude-engine.js'
import type {
  SkillTrace,
  AnalysisResult,
  NightlyReport,
  NightlySkillReport,
  SelfIterationConfig,
} from './types.js'
import { SkillOptimizer } from './optimizer.js'
import { DEFAULT_CONFIG, SKILLS_DIR } from './config.js'

export class IterationChecker {
  private claudeEngine: ClaudeEngine
  private optimizer: SkillOptimizer
  private config: SelfIterationConfig

  constructor(claudeEngine: ClaudeEngine, config?: SelfIterationConfig) {
    this.claudeEngine = claudeEngine
    this.config = config ?? DEFAULT_CONFIG
    this.optimizer = new SkillOptimizer(this.config)
  }

  /**
   * 每夜批量分析入口 — 由 CronJob 调用
   */
  async runNightly(skillFilter: 'all' | string[]): Promise<NightlyReport> {
    const report: NightlyReport = {
      runAt: new Date().toISOString(),
      skills: [],
    }

    if (!this.config.enabled) {
      console.log('[IterationChecker] Self-iteration disabled')
      return report
    }

    const skills = skillFilter === 'all'
      ? this.discoverSkillsWithTraces()
      : skillFilter

    console.log(`🌙 [IterationChecker] Nightly run: ${skills.length} skills to check`)

    for (const skillName of skills) {
      const skillReport = await this.processSkill(skillName)
      report.skills.push(skillReport)
    }

    console.log(
      `🌙 [IterationChecker] Nightly complete: ${report.skills.filter((s) => s.action === 'analyzed').length} analyzed, ` +
      `${report.skills.filter((s) => s.action === 'optimized').length} optimized, ` +
      `${report.skills.filter((s) => s.action === 'skipped').length} skipped`,
    )

    return report
  }

  // ─── 单个 Skill 处理 ───

  private async processSkill(skillName: string): Promise<NightlySkillReport> {
    try {
      // ── Phase 1: 收集未分析的 trace 文件 ──
      const { traces, dateFiles } = this.loadUnanalyzedTraces(skillName)
      if (traces.length === 0) {
        return { skillName, tracesAnalyzed: 0, action: 'skipped', reason: 'No new traces' }
      }

      console.log(`📊 [IterationChecker] "${skillName}": ${traces.length} new traces from ${dateFiles.length} day(s)`)

      // ── Phase 2: 调用 SubAgent 分析 ──
      const currentSkillMd = this.loadSkillMd(skillName)
      const existingBP = this.loadKnowledgeFile(skillName, 'best-practices.md')
      const existingPitfalls = this.loadKnowledgeFile(skillName, 'pitfalls.md')

      const analysisResult = await this.callSubAgent(
        skillName,
        currentSkillMd,
        traces,
        existingBP,
        existingPitfalls,
      )

      if (!analysisResult) {
        return { skillName, tracesAnalyzed: traces.length, action: 'error', reason: 'SubAgent returned invalid response' }
      }

      // 写入知识文件
      this.writeKnowledgeFiles(skillName, analysisResult)

      // 更新 last_analyzed（在 best-practices.md frontmatter 中）
      const latestDate = dateFiles.sort().pop()!
      this.updateLastAnalyzed(skillName, latestDate, analysisResult)

      // ── Phase 3: 条件性优化 SKILL.md ──
      if (analysisResult.shouldOptimize && analysisResult.newContent) {
        const result = this.optimizer.apply(
          skillName,
          analysisResult.newContent,
          analysisResult.diffRatio ?? 0.5,
        )

        if (result.success) {
          return { skillName, tracesAnalyzed: traces.length, action: 'optimized', reason: result.reason }
        } else {
          return { skillName, tracesAnalyzed: traces.length, action: 'analyzed', reason: `Knowledge updated, SKILL.md not changed: ${result.reason}` }
        }
      }

      return { skillName, tracesAnalyzed: traces.length, action: 'analyzed', reason: analysisResult.analysis }
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

  // ─── Phase 1: 加载未分析 Traces ───

  private loadUnanalyzedTraces(skillName: string): {
    traces: SkillTrace[]
    dateFiles: string[]
  } {
    const tracesDir = join(SKILLS_DIR, skillName, 'iteration', 'traces')
    if (!existsSync(tracesDir)) return { traces: [], dateFiles: [] }

    const lastAnalyzed = this.getLastAnalyzed(skillName)

    // 找所有 > lastAnalyzed 的日期文件
    const allFiles = readdirSync(tracesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()

    const newDateFiles = lastAnalyzed
      ? allFiles.filter((d) => d > lastAnalyzed)
      : allFiles

    if (newDateFiles.length === 0) return { traces: [], dateFiles: [] }

    const traces: SkillTrace[] = []
    for (const dateStr of newDateFiles) {
      const filePath = join(tracesDir, `${dateStr}.jsonl`)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            traces.push(JSON.parse(line) as SkillTrace)
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // skip unreadable file
      }
    }

    return { traces, dateFiles: newDateFiles }
  }

  private getLastAnalyzed(skillName: string): string | null {
    const bpPath = join(SKILLS_DIR, skillName, 'iteration', 'best-practices.md')
    if (!existsSync(bpPath)) return null

    try {
      const content = readFileSync(bpPath, 'utf-8')
      const match = content.match(/last_analyzed:\s*"?(\d{4}-\d{2}-\d{2})"?/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  // ─── Phase 2: 调用 SubAgent ───

  private async callSubAgent(
    skillName: string,
    currentSkillMd: string,
    traces: SkillTrace[],
    existingBP: string,
    existingPitfalls: string,
  ): Promise<AnalysisResult | null> {
    // 格式化 traces — 截断到合理大小
    const maxTraces = 50
    const recentTraces = traces.slice(-maxTraces)

    const traceSummary = recentTraces
      .map(
        (t) =>
          `[${t.traceId}] status=${t.status}, duration=${t.duration}ms, error=${t.error ?? 'none'}\n` +
          `  intent: ${t.input.userIntent}\n` +
          `  steps:\n${t.steps.map((s) => `    - ${s.toolName}: ${s.output.status} (${s.output.durationMs}ms) ${s.output.error ?? ''}`).join('\n')}\n` +
          `  output: ${t.output.result.slice(0, 300)}`,
      )
      .join('\n\n')

    const prompt = `Analyze the following execution traces for skill "${skillName}" and generate knowledge + optional SKILL.md improvement.

<current-skill>
${currentSkillMd}
</current-skill>

<traces>
${traceSummary}
</traces>

<best-practices>
${existingBP || '(empty — first analysis)'}
</best-practices>

<pitfalls>
${existingPitfalls || '(empty — first analysis)'}
</pitfalls>

Trace summary: ${recentTraces.length} total, ${recentTraces.filter((t) => t.status === 'success').length} success, ${recentTraces.filter((t) => t.status !== 'success').length} failure/partial.

Remember: output STRICT JSON only.`

    try {
      const response = await this.claudeEngine.sendMessage(
        prompt,
        `You are the Skill self-iteration optimizer. Analyze execution traces and output JSON with: analysis, bestPractices, pitfalls, shouldOptimize, newContent (if needed), diffRatio, confidence.\n\nJSON schema: {"analysis": string, "bestPractices": string, "pitfalls": string, "shouldOptimize": boolean, "newContent"?: string, "diffRatio"?: number, "confidence"?: number}`,
      )

      return this.parseAnalysisResult(response.content)
    } catch (err) {
      console.error(`[IterationChecker] SubAgent call failed for "${skillName}":`, err)
      return null
    }
  }

  private parseAnalysisResult(content: string): AnalysisResult | null {
    // 尝试直接解析
    try {
      const parsed = JSON.parse(content)
      if (this.isValidAnalysisResult(parsed)) return parsed
    } catch { /* fallthrough */ }

    // 提取 JSON 块
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        if (this.isValidAnalysisResult(parsed)) return parsed
      } catch { /* fallthrough */ }
    }

    // 从 code fence 中提取
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim())
        if (this.isValidAnalysisResult(parsed)) return parsed
      } catch { /* fallthrough */ }
    }

    console.error('[IterationChecker] Failed to parse SubAgent response')
    return null
  }

  private isValidAnalysisResult(obj: any): obj is AnalysisResult {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.analysis === 'string' &&
      typeof obj.bestPractices === 'string' &&
      typeof obj.pitfalls === 'string' &&
      typeof obj.shouldOptimize === 'boolean'
    )
  }

  // ─── 知识文件读写 ───

  private loadSkillMd(skillName: string): string {
    const path = this.optimizer.resolveSkillMdPath(skillName)
    if (!path) return '(SKILL.md not found)'
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return '(SKILL.md unreadable)'
    }
  }

  private loadKnowledgeFile(skillName: string, fileName: string): string {
    const filePath = join(SKILLS_DIR, skillName, 'iteration', fileName)
    if (!existsSync(filePath)) return ''
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  private writeKnowledgeFiles(skillName: string, result: AnalysisResult): void {
    const iterDir = join(SKILLS_DIR, skillName, 'iteration')
    if (!existsSync(iterDir)) mkdirSync(iterDir, { recursive: true })

    if (result.bestPractices) {
      writeFileSync(join(iterDir, 'best-practices.md'), result.bestPractices, 'utf-8')
    }
    if (result.pitfalls) {
      writeFileSync(join(iterDir, 'pitfalls.md'), result.pitfalls, 'utf-8')
    }
  }

  private updateLastAnalyzed(
    skillName: string,
    latestDate: string,
    result: AnalysisResult,
  ): void {
    // 重写 best-practices.md，在 frontmatter 中记录 last_analyzed 和 optimization_dates
    const iterDir = join(SKILLS_DIR, skillName, 'iteration')
    const bpPath = join(iterDir, 'best-practices.md')

    let content = result.bestPractices || ''

    // 去掉 SubAgent 可能生成的 frontmatter（我们自己加）
    content = content.replace(/^---\n[\s\S]*?\n---\n*/, '')

    const today = new Date().toISOString().slice(0, 10)

    // 读取已有的 optimization_dates
    let optimizationDates: string[] = []
    if (existsSync(bpPath)) {
      try {
        const existing = readFileSync(bpPath, 'utf-8')
        const match = existing.match(/optimization_dates:\s*\[(.*?)\]/)
        if (match) {
          optimizationDates = match[1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean)
        }
      } catch { /* ignore */ }
    }

    // 如果今天优化了 SKILL.md，追加今天的日期
    if (result.shouldOptimize && result.newContent) {
      optimizationDates.push(today)
    }

    // 只保留最近 30 天的记录
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    optimizationDates = optimizationDates.filter((d) => d >= cutoffStr)

    const frontmatter = [
      '---',
      `last_analyzed: "${latestDate}"`,
      `optimization_dates: [${optimizationDates.map((d) => `"${d}"`).join(', ')}]`,
      '---',
      '',
    ].join('\n')

    writeFileSync(bpPath, frontmatter + content, 'utf-8')
  }

  // ─── Skill 发现 ───

  private discoverSkillsWithTraces(): string[] {
    if (!existsSync(SKILLS_DIR)) return []

    try {
      return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => {
          const tracesDir = join(SKILLS_DIR, e.name, 'iteration', 'traces')
          return existsSync(tracesDir)
        })
        .map((e) => e.name)
    } catch {
      return []
    }
  }
}
