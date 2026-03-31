// src/core/self-iteration/trace-collector.ts
// Trace 采集器 (V3) — 按天写入 .claude/skills/{name}/iteration/traces/{date}.jsonl

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import type { SkillTrace, SkillStep } from './types.js'
import { SKILLS_DIR } from './config.js'

/** 活跃 Trace — 内存中跟踪正在执行的 Skill 调用 */
interface ActiveTrace {
  traceId: string
  skillName: string
  skillToolUseId: string
  sessionId: string
  userIntent: string
  startedAt: number
  steps: SkillStep[]
  skillInput: Record<string, unknown>
  pendingSteps: Map<
    string,
    {
      stepIndex: number
      toolName: string
      input: Record<string, unknown>
      startedAt: number
    }
  >
}

export class TraceCollector {
  /** Skill toolUseId → ActiveTrace */
  private activeTraces = new Map<string, ActiveTrace>()

  /** sessionId → 本轮 turn 中调用的 skill 名称集合 */
  private turnSkills = new Map<string, Set<string>>()

  // ─── Public API ───

  /**
   * Skill 调用开始
   */
  startTrace(
    skillName: string,
    skillToolUseId: string,
    sessionId: string,
    userIntent: string,
    skillInput?: Record<string, unknown>,
  ): void {
    const traceId = `tr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`

    this.activeTraces.set(skillToolUseId, {
      traceId,
      skillName,
      skillToolUseId,
      sessionId,
      userIntent,
      startedAt: Date.now(),
      steps: [],
      skillInput: skillInput ?? {},
      pendingSteps: new Map(),
    })

    if (!this.turnSkills.has(sessionId)) {
      this.turnSkills.set(sessionId, new Set())
    }
    this.turnSkills.get(sessionId)!.add(skillName)

    console.log(
      `📊 [TraceCollector] Started trace ${traceId} for skill "${skillName}" (toolUseId=${skillToolUseId})`,
    )
  }

  /**
   * Skill 内部工具调用开始
   */
  addStepStart(
    parentToolUseId: string,
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
  ): void {
    const trace = this.activeTraces.get(parentToolUseId)
    if (!trace) return

    trace.pendingSteps.set(toolUseId, {
      stepIndex: trace.steps.length + trace.pendingSteps.size,
      toolName,
      input,
      startedAt: Date.now(),
    })
  }

  /**
   * Skill 内部工具调用结束
   */
  addStepEnd(toolUseId: string, result: string, status: 'ok' | 'error'): void {
    for (const trace of this.activeTraces.values()) {
      const pending = trace.pendingSteps.get(toolUseId)
      if (!pending) continue

      trace.pendingSteps.delete(toolUseId)
      trace.steps.push({
        stepIndex: pending.stepIndex,
        toolName: pending.toolName,
        input: pending.input,
        output: {
          summary: result.slice(0, 1000),
          durationMs: Date.now() - pending.startedAt,
          status,
          error: status === 'error' ? result.slice(0, 500) : undefined,
        },
      })
      return
    }
  }

  /**
   * Skill 执行结束 — 持久化到按天 traces 文件
   */
  async finishTrace(skillToolUseId: string, result: string): Promise<void> {
    const active = this.activeTraces.get(skillToolUseId)
    if (!active) return

    this.activeTraces.delete(skillToolUseId)

    const now = Date.now()
    const status = this.inferStatus(result, active.steps)

    const trace: SkillTrace = {
      traceId: active.traceId,
      skillName: active.skillName,
      sessionId: active.sessionId,
      startedAt: new Date(active.startedAt).toISOString(),
      finishedAt: new Date(now).toISOString(),
      duration: now - active.startedAt,
      input: {
        userIntent: active.userIntent,
        matchedPattern: active.skillInput?.args
          ? String(active.skillInput.args).slice(0, 500)
          : undefined,
      },
      steps: active.steps.sort((a, b) => a.stepIndex - b.stepIndex),
      output: {
        result: result.slice(0, 3000),
      },
      status,
    }

    try {
      this.appendTrace(active.skillName, trace)
    } catch (err) {
      console.error(`[TraceCollector] Failed to persist trace:`, err)
    }

    console.log(
      `📊 [TraceCollector] Finished trace ${active.traceId}: ${status} (${trace.duration}ms, ${trace.steps.length} steps)`,
    )
  }

  hasActiveTrace(toolUseId: string): boolean {
    return this.activeTraces.has(toolUseId)
  }

  hasPendingStep(toolUseId: string): boolean {
    for (const trace of this.activeTraces.values()) {
      if (trace.pendingSteps.has(toolUseId)) return true
    }
    return false
  }

  flushTurnSkills(sessionId: string): string[] {
    const skills = this.turnSkills.get(sessionId)
    if (!skills) return []
    const list = [...skills]
    this.turnSkills.delete(sessionId)
    return list
  }

  // ─── Private ───

  private inferStatus(
    result: string,
    steps: SkillStep[],
  ): 'success' | 'failure' | 'partial' {
    const hasErrorSteps = steps.some((s) => s.output.status === 'error')
    const failureKeywords = ['error', 'failed', 'Error', 'FAILED', '失败', '错误', 'exception', 'Exception']
    const resultLower = result.toLowerCase()
    const resultHasError = failureKeywords.some((kw) => resultLower.includes(kw.toLowerCase()))

    if (resultHasError && hasErrorSteps) return 'failure'
    if (resultHasError || hasErrorSteps) return 'partial'
    return 'success'
  }

  /**
   * 写入按天 trace 文件: .claude/skills/{name}/iteration/traces/{date}.jsonl
   */
  private appendTrace(skillName: string, trace: SkillTrace): void {
    const today = new Date().toISOString().slice(0, 10)
    const filePath = join(SKILLS_DIR, skillName, 'iteration', 'traces', `${today}.jsonl`)
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    appendFileSync(filePath, JSON.stringify(trace) + '\n', 'utf-8')
  }
}
