// src/core/self-iteration/trace-collector.ts
// Trace 采集器 (V5) — 全量 timeline 模式
//
// V5 核心变化：
//   - 按 turn 维度记录全量 timeline 事件流
//   - 写入 per-skill 路径: {skillName}/iteration/traces/{date}.jsonl
//   - 读取时由 sliceForSkill() 按需切片

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import type {
  TimelineEvent,
  TurnTrace,
  SkillView,
  SkillStep,
  SkillTrace,
} from './types.js'
import { SKILLS_DIR } from './config.js'

/** 活跃 turn — 内存中跟踪正在进行的 turn */
interface ActiveTurn {
  sessionId: string
  userIntent: string
  startedAt: number
  timeline: TimelineEvent[]
}

export class TraceCollector {
  /** sessionId → ActiveTurn（一个 session 同时只有一个活跃 turn） */
  private activeTurns = new Map<string, ActiveTurn>()

  // ─── Public API（由 EventTap 调用） ───

  startTurn(sessionId: string, userIntent: string): void {
    this.activeTurns.set(sessionId, {
      sessionId,
      userIntent,
      startedAt: Date.now(),
      timeline: [],
    })
  }

  addEvent(sessionId: string, event: TimelineEvent): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn) return
    turn.timeline.push(event)
  }

  async finishTurn(sessionId: string, finalOutput: string): Promise<void> {
    const turn = this.activeTurns.get(sessionId)
    if (!turn) return

    this.activeTurns.delete(sessionId)

    const now = Date.now()

    turn.timeline.push({
      ts: now,
      type: 'turn_end',
      output: finalOutput,
    })

    const trace: TurnTrace = {
      sessionId: turn.sessionId,
      userIntent: turn.userIntent,
      startedAt: new Date(turn.startedAt).toISOString(),
      finishedAt: new Date(now).toISOString(),
      duration: now - turn.startedAt,
      timeline: turn.timeline,
      output: finalOutput,
      status: TraceCollector.inferStatusFromEvents(turn.timeline),
    }

    // 只有包含 Skill 调用的 turn 才写入
    const hasSkill = turn.timeline.some(e => e.type === 'skill_start')
    if (!hasSkill) return

    try {
      this.persistPerSkill(trace)
    } catch (err) {
      console.error(`[TraceCollector] Failed to persist trace:`, err)
    }

    const skillCount = turn.timeline.filter(e => e.type === 'skill_start').length
    const toolCount = turn.timeline.filter(e => e.type === 'tool_start').length
    console.log(
      `📊 [TraceCollector] Turn finished: ${trace.status} (${trace.duration}ms, ` +
      `${skillCount} skill(s), ${toolCount} tool call(s))`,
    )
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  // ─── 静态工具：读取时 slice ───

  static sliceForSkill(trace: TurnTrace, skillName: string): SkillView | null {
    const startIdx = trace.timeline.findIndex(
      e => e.type === 'skill_start' && e.skill === skillName,
    )
    if (startIdx === -1) return null

    const events = trace.timeline.slice(startIdx)
    const startTs = events[0].ts
    const endTs = events[events.length - 1]?.ts ?? startTs

    return {
      skillName,
      startedAt: startTs,
      finishedAt: endTs,
      duration: endTs - startTs,
      events,
      steps: TraceCollector.extractSteps(events),
      status: TraceCollector.inferStatusFromEvents(events),
    }
  }

  static extractSkillNames(trace: TurnTrace): string[] {
    return trace.timeline
      .filter(e => e.type === 'skill_start' && e.skill)
      .map(e => e.skill!)
  }

  static toSkillTrace(view: SkillView, userIntent: string, sessionId: string): SkillTrace {
    return {
      sessionId,
      startedAt: new Date(view.startedAt).toISOString(),
      finishedAt: new Date(view.finishedAt).toISOString(),
      duration: view.duration,
      userIntent,
      steps: view.steps,
      output: view.events.find(e => e.type === 'turn_end')?.output ?? '',
      status: view.status,
    }
  }

  // ─── Private：持久化 ───

  /**
   * 按 Skill 维度写入各自目录
   * 路径：.claude/skills/{skillName}/iteration/traces/{date}.jsonl
   */
  private persistPerSkill(trace: TurnTrace): void {
    const skillNames = TraceCollector.extractSkillNames(trace)
    const today = new Date().toISOString().slice(0, 10)

    for (const skillName of skillNames) {
      const view = TraceCollector.sliceForSkill(trace, skillName)
      if (!view) continue

      const skillTrace = TraceCollector.toSkillTrace(view, trace.userIntent, trace.sessionId)
      const filePath = join(SKILLS_DIR, skillName, 'iteration', 'traces', `${today}.jsonl`)
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(filePath, JSON.stringify(skillTrace) + '\n', 'utf-8')

      console.log(`📝 [TraceCollector] Written trace for "${skillName}" → ${filePath}`)
    }
  }

  // ─── Private：工具方法 ───

  private static extractSteps(events: TimelineEvent[]): SkillStep[] {
    const steps: SkillStep[] = []
    const pending = new Map<string, TimelineEvent>()

    for (const e of events) {
      if (e.type === 'tool_start' && e.toolUseId) {
        pending.set(e.toolUseId, e)
      } else if (e.type === 'tool_end' && e.toolUseId) {
        const start = pending.get(e.toolUseId)
        if (start) {
          pending.delete(e.toolUseId)
          steps.push({
            toolName: start.tool ?? 'unknown',
            input: start.input ?? {},
            output: e.output ?? '',
            durationMs: e.ts - start.ts,
            status: e.status ?? 'ok',
          })
        }
      }
    }

    return steps
  }

  private static inferStatusFromEvents(events: TimelineEvent[]): 'success' | 'failure' | 'partial' {
    const errors = events.filter(e => e.type === 'tool_end' && e.status === 'error')
    const tools = events.filter(e => e.type === 'tool_end')
    if (tools.length === 0) return 'success'
    if (errors.length === tools.length) return 'failure'
    if (errors.length > 0) return 'partial'
    return 'success'
  }

  // ─── 静态工具：从文件加载 ───

  static loadSkillTraces(skillName: string, date: string): SkillTrace[] {
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
}
