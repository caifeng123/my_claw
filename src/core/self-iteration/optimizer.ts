// src/core/self-iteration/optimizer.ts
// Skill 优化器 (V3) — 精简版: 安全检查 → 写入 SKILL.md
// SubAgent 调用已移到 IterationChecker，这里只负责安全校验和写入

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SelfIterationConfig } from './types.js'
import { DEFAULT_CONFIG, SKILLS_DIR } from './config.js'

export class SkillOptimizer {
  private config: SelfIterationConfig

  constructor(config?: SelfIterationConfig) {
    this.config = config ?? DEFAULT_CONFIG
  }

  /**
   * 安全检查 + 写入新 SKILL.md
   * 由 IterationChecker 在 Phase 3 调用
   *
   * @param skillName  Skill 名称
   * @param newContent SubAgent 生成的新 SKILL.md 内容
   * @param diffRatio  SubAgent 报告的 diff ratio
   */
  apply(
    skillName: string,
    newContent: string,
    diffRatio: number,
  ): { success: boolean; reason: string } {
    const skillMdPath = this.resolveSkillMdPath(skillName)
    if (!skillMdPath) {
      return { success: false, reason: `SKILL.md not found for "${skillName}"` }
    }

    const currentContent = readFileSync(skillMdPath, 'utf-8')

    // ── 安全检查 ──
    const safety = this.safetyCheck(skillName, currentContent, newContent, diffRatio)
    if (!safety.passed) {
      return { success: false, reason: safety.reason }
    }

    // ── 写入 ──
    writeFileSync(skillMdPath, newContent, 'utf-8')

    console.log(`✅ [SkillOptimizer] SKILL.md updated for "${skillName}"`)
    return { success: true, reason: 'SKILL.md updated successfully' }
  }

  // ─── 安全检查 ───

  private safetyCheck(
    skillName: string,
    currentContent: string,
    newContent: string,
    diffRatio: number,
  ): { passed: boolean; reason: string } {
    // 1. Diff ratio
    if (diffRatio > this.config.safety.maxSkillMdDiffRatio) {
      return {
        passed: false,
        reason: `Diff ratio ${diffRatio} exceeds max ${this.config.safety.maxSkillMdDiffRatio}`,
      }
    }

    // 2. Frontmatter 保护
    const currentFM = this.extractFrontmatter(currentContent)
    const newFM = this.extractFrontmatter(newContent)
    if (currentFM && newFM && currentFM !== newFM) {
      return { passed: false, reason: 'YAML frontmatter was modified (forbidden)' }
    }
    if (currentFM && !newFM) {
      return { passed: false, reason: 'YAML frontmatter was removed (forbidden)' }
    }

    // 3. 每日优化次数限制 — 检查今天 iteration 目录下 traces 中是否有优化记录
    // 简化：用 best-practices.md 的 mtime 近似判断（同一天多次更新算一次优化）
    // 更精确的方式可以在 best-practices.md frontmatter 里记录 today_optimizations
    // 此处先做简单检查
    const todayCount = this.getTodayOptimizationCount(skillName)
    if (todayCount >= this.config.safety.maxOptimizationsPerDay) {
      return {
        passed: false,
        reason: `Daily optimization limit reached (${todayCount}/${this.config.safety.maxOptimizationsPerDay})`,
      }
    }

    // 4. 内容非空
    if (!newContent.trim()) {
      return { passed: false, reason: 'New content is empty' }
    }

    return { passed: true, reason: 'All safety checks passed' }
  }

  private extractFrontmatter(content: string): string | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    return match ? match[1].trim() : null
  }

  private getTodayOptimizationCount(skillName: string): number {
    // 读取 best-practices.md 的 frontmatter 中的 optimization_dates
    const bpPath = join(SKILLS_DIR, skillName, 'iteration', 'best-practices.md')
    if (!existsSync(bpPath)) return 0

    try {
      const content = readFileSync(bpPath, 'utf-8')
      const fm = this.extractFrontmatter(content)
      if (!fm) return 0

      // 从 frontmatter 中提取 optimization_dates 列表
      const match = fm.match(/optimization_dates:\s*\[(.*?)\]/)
      if (!match) return 0

      const today = new Date().toISOString().slice(0, 10)
      const dates = match[1].split(',').map((s) => s.trim().replace(/"/g, ''))
      return dates.filter((d) => d === today).length
    } catch {
      return 0
    }
  }

  // ─── 路径解析 ───

  resolveSkillMdPath(skillName: string): string | null {
    const candidates = [
      join(SKILLS_DIR, skillName, 'SKILL.md'),
      join(SKILLS_DIR, `${skillName}.md`),
      join(SKILLS_DIR, skillName, 'skill.md'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }

    if (existsSync(SKILLS_DIR)) {
      const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      for (const d of dirs) {
        if (d.isDirectory() && d.name.toLowerCase() === skillName.toLowerCase()) {
          const p = join(SKILLS_DIR, d.name, 'SKILL.md')
          if (existsSync(p)) return p
        }
      }
    }

    return null
  }
}
