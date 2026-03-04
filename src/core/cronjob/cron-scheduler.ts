/**
 * CronJob 调度引擎
 * 
 * 每 30 秒 tick 一次，遍历启用的任务，到期则执行。
 * - 防重入：内存 Set 记录正在执行的 jobId
 * - 重启恢复：从文件读取 lastRunAt，自动补执行错过的任务
 * - 日志清理：启动时 + 每天凌晨清理过期日志
 */

import cronParser from 'cron-parser'
import { CronStore } from './cron-store.js'
import { CronExecutor } from './cron-executor.js'
import type { CronJob } from './types.js'

export class CronScheduler {
  private store: CronStore
  private executor: CronExecutor
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private runningJobs = new Set<string>()
  private readonly TICK_INTERVAL = 30_000 // 30 秒

  constructor() {
    this.store = new CronStore()
    this.executor = new CronExecutor(this.store)
    this.start()
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.tickTimer) return
    console.log('⏰ CronScheduler 启动')

    // 启动时清理一次过期日志
    this.store.cleanOldLogs()

    // 立即 tick 一次（补偿重启期间错过的任务）
    this.tick()

    // 定时 tick
    this.tickTimer = setInterval(() => this.tick(), this.TICK_INTERVAL)

    // 每天凌晨 3 点清理日志（简化实现：每小时检查一次）
    this.cleanupTimer = setInterval(() => {
      const hour = new Date().getHours()
      if (hour === 3) {
        this.store.cleanOldLogs()
      }
    }, 60 * 60 * 1000)
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    console.log('⏰ CronScheduler 已停止')
  }

  /**
   * 每个 tick：扫描到期任务并执行
   */
  private async tick(): Promise<void> {
    const now = Date.now()
    const enabledJobs = this.store.listJobs(true)

    for (const job of enabledJobs) {
      // 防重入
      if (this.runningJobs.has(job.id)) continue

      // 计算下次执行时间
      const nextRun = this.getNextRunTime(job)
      if (nextRun !== null && nextRun <= now) {
        this.runningJobs.add(job.id)

        // 异步执行，不阻塞 tick 循环
        this.executor.execute(job).finally(() => {
          this.runningJobs.delete(job.id)
        })
      }
    }
  }

  /**
   * 计算任务的下次执行时间
   * 基于 lastRunAt（或 createdAt）往后找下一个匹配的时间点
   */
  getNextRunTime(job: CronJob): number | null {
    try {
      const baseTime = job.lastRunAt || job.createdAt
      const interval = cronParser.parseExpression(job.cron, {
        currentDate: new Date(baseTime),
      })
      return interval.next().getTime()
    } catch (error) {
      console.error(`❌ 解析 cron 表达式失败 [${job.name}]: ${job.cron}`, error)
      return null
    }
  }

  // ==================== 公共 API ====================

  getStore(): CronStore {
    return this.store
  }

  /**
   * 手动触发一次任务
   */
  async triggerJob(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId)
    if (!job) throw new Error(`任务不存在: ${jobId}`)
    if (this.runningJobs.has(jobId)) throw new Error(`任务正在执行中: ${jobId}`)

    this.runningJobs.add(jobId)
    try {
      await this.executor.execute(job)
    } finally {
      this.runningJobs.delete(jobId)
    }
  }
}
