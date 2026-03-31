// src/core/self-iteration/trace-collector.ts
// Trace 采集器 (V4) — 由 EventTap 驱动，按天写入 traces/{date}.jsonl
//
// 核心变化：
//   - 不截断任何内容，完整记录所有 tool 输入输出
//   - 精简字段：去掉 traceId / sessionId / skillName（已在文件路径中）
//   - 嵌套 Skill 自然作为 step 记录（parentToolUseId 链）

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
  skillName: string
  skillToolUseId: string
  userIntent: string
  startedAt: number
  steps: SkillStep[]
  /** toolUseId → pending step info */
  pendingSteps: Map<string, {
    toolName: string
    input: Record<string, unknown>
    startedAt: number
  }>
}

export class TraceCollector {
  /** Skill toolUseId → ActiveTrace */
  private activeTraces = new Map<string, ActiveTrace>()

  // ─── Public API（由 EventTap 调用） ───

  /**
   * Skill 调用开始
   */
  startTrace(
    skillName: string,
    skillToolUseId: string,
    _sessionId: string,
    userIntent: string,
    _skillInput?: Record<string, unknown>,
  ): void {
    this.activeTraces.set(skillToolUseId, {
      skillName,
      skillToolUseId,
      userIntent,
      startedAt: Date.now(),
      steps: [],
      pendingSteps: new Map(),
    })

    console.log(`📊 [TraceCollector] Started trace for "${skillName}" (toolUseId=${skillToolUseId})`)
  }

  /**
   * Skill 内部工具调用开始（包括嵌套 Skill）
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
      toolName,
      input,
      startedAt: Date.now(),
    })
  }

  /**
   * Skill 内部工具调用结束 — 不截断结果
   */
  addStepEnd(toolUseId: string, result: string, status: 'ok' | 'error'): void {
    for (const trace of this.activeTraces.values()) {
      const pending = trace.pendingSteps.get(toolUseId)
      if (!pending) continue

      trace.pendingSteps.delete(toolUseId)
      trace.steps.push({
        toolName: pending.toolName,
        input: pending.input,
        output: result,
        durationMs: Date.now() - pending.startedAt,
        status,
      })
      return
    }
  }

  /**
   * Skill 执行结束 — 持久化完整 trace（不截断）
   */
  async finishTrace(skillToolUseId: string, result: string): Promise<void> {
    const active = this.activeTraces.get(skillToolUseId)
    if (!active) return

    this.activeTraces.delete(skillToolUseId)

    const now = Date.now()

    const trace: SkillTrace = {
      startedAt: new Date(active.startedAt).toISOString(),
      finishedAt: new Date(now).toISOString(),
      duration: now - active.startedAt,
      userIntent: active.userIntent,
      steps: active.steps,
      output: result,
      status: this.inferStatus(result, active.steps),
    }

    try {
      this.appendTrace(active.skillName, trace)
    } catch (err) {
      console.error(`[TraceCollector] Failed to persist trace:`, err)
    }

    console.log(
      `📊 [TraceCollector] Finished "${active.skillName}": ${trace.status} (${trace.duration}ms, ${trace.steps.length} steps)`,
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

  // ─── Private ───

  private inferStatus(
    result: string,
    steps: SkillStep[],
  ): 'success' | 'failure' | 'partial' {
    const hasErrorSteps = steps.some(s => s.status === 'error')
    const failureKeywords = ['error', 'failed', 'Error', 'FAILED', '失败', '错误', 'exception', 'Exception']
    const resultLower = result.toLowerCase()
    const resultHasError = failureKeywords.some(kw => resultLower.includes(kw.toLowerCase()))

    if (resultHasError && hasErrorSteps) return 'failure'
    if (resultHasError || hasErrorSteps) return 'partial'
    return 'success'
  }

  private appendTrace(skillName: string, trace: SkillTrace): void {
    const today = new Date().toISOString().slice(0, 10)
    const filePath = join(SKILLS_DIR, skillName, 'iteration', 'traces', `${today}.jsonl`)
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    appendFileSync(filePath, JSON.stringify(trace) + '\n', 'utf-8')
  }
}
