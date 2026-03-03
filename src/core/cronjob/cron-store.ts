/**
 * CronJob 持久化存储
 * 
 * - cronjobs.json: 任务定义，全量读写
 * - cronjob-logs.jsonl: 执行日志，append-only
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { CronJob, CronJobLog, CreateCronJobInput } from './types.js'

const JOBS_FILE = 'data/cronjobs.json'
const LOGS_FILE = 'data/cronjob-logs.jsonl'

export class CronStore {
  constructor() {
    // 确保 data 目录存在
    const dir = dirname(JOBS_FILE)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // ==================== Jobs CRUD ====================

  /**
   * 加载所有任务
   */
  loadJobs(): CronJob[] {
    if (!existsSync(JOBS_FILE)) return []
    try {
      const raw = readFileSync(JOBS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      return Array.isArray(data.jobs) ? data.jobs : []
    } catch {
      console.warn('⚠️ 读取 cronjobs.json 失败，返回空列表')
      return []
    }
  }

  /**
   * 保存所有任务（原子写：先写 tmp 再 rename）
   */
  saveJobs(jobs: CronJob[]): void {
    const content = JSON.stringify({ jobs }, null, 2)
    const tmpFile = `${JOBS_FILE}.tmp`
    writeFileSync(tmpFile, content, 'utf-8')
    renameSync(tmpFile, JOBS_FILE)
  }

  /**
   * 创建任务
   */
  createJob(input: CreateCronJobInput): CronJob {
    const jobs = this.loadJobs()
    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
    }
    jobs.push(job)
    this.saveJobs(jobs)
    console.log(`✅ CronJob 创建成功: [${job.name}] (${job.id})`)
    return job
  }

  /**
   * 按 ID 查找任务
   */
  getJob(id: string): CronJob | null {
    return this.loadJobs().find(j => j.id === id) ?? null
  }

  /**
   * 列出任务
   */
  listJobs(enabledOnly = false): CronJob[] {
    const jobs = this.loadJobs()
    return enabledOnly ? jobs.filter(j => j.enabled) : jobs
  }

  /**
   * 更新任务
   */
  updateJob(id: string, updates: Partial<CronJob>): CronJob | null {
    const jobs = this.loadJobs()
    const index = jobs.findIndex(j => j.id === id)
    if (index === -1) return null

    // 不允许通过 updates 修改 id 和 createdAt
    const { id: _id, createdAt: _ca, ...safeUpdates } = updates
    jobs[index] = { ...jobs[index], ...safeUpdates } as CronJob
    this.saveJobs(jobs)
    return jobs[index]
  }

  /**
   * 删除任务
   */
  deleteJob(id: string): boolean {
    const jobs = this.loadJobs()
    const filtered = jobs.filter(j => j.id !== id)
    if (filtered.length === jobs.length) return false
    this.saveJobs(filtered)
    console.log(`🗑️ CronJob 已删除: ${id}`)
    return true
  }

  // ==================== Logs ====================

  /**
   * 追加一条执行日志
   */
  appendLog(log: CronJobLog): void {
    const line = JSON.stringify(log) + '\n'
    appendFileSync(LOGS_FILE, line, 'utf-8')
  }

  /**
   * 查看指定任务的执行日志（倒序，最近的在前）
   */
  getJobLogs(jobId: string, limit = 10): CronJobLog[] {
    if (!existsSync(LOGS_FILE)) return []
    try {
      const raw = readFileSync(LOGS_FILE, 'utf-8')
      const allLogs: CronJobLog[] = raw
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter((log): log is CronJobLog => log !== null && log.jobId === jobId)

      // 倒序取最近 N 条
      return allLogs.reverse().slice(0, limit)
    } catch {
      return []
    }
  }

  /**
   * 清理过期日志（默认保留 7 天）
   */
  cleanOldLogs(maxAge = 7 * 24 * 60 * 60 * 1000): number {
    if (!existsSync(LOGS_FILE)) return 0
    try {
      const raw = readFileSync(LOGS_FILE, 'utf-8')
      const cutoff = Date.now() - maxAge
      const lines = raw.split('\n').filter(line => line.trim())
      const kept: string[] = []
      let removed = 0

      for (const line of lines) {
        try {
          const log = JSON.parse(line) as CronJobLog
          if (log.startedAt >= cutoff) {
            kept.push(line)
          } else {
            removed++
          }
        } catch {
          // 格式损坏的行直接丢弃
          removed++
        }
      }

      if (removed > 0) {
        writeFileSync(LOGS_FILE, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8')
        console.log(`🧹 清理了 ${removed} 条过期 CronJob 日志`)
      }
      return removed
    } catch {
      return 0
    }
  }
}
