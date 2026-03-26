/**
 * CronJob Agent 工具
 * 
 * 注册给 Agent 的 4 个工具，让用户通过飞书自然语言管理定时任务。
 * 
 * 注册方式与 calculator.ts / memory-tools.ts / tavily-tools.ts 一致：
 * 返回 RegisteredTool[]，由 ToolManager.registerTools() 批量注册。
 */

import z from 'zod'
import type { RegisteredTool } from '../types/tools.js'
import type { CronScheduler } from '../../cronjob/cron-scheduler.js'
import type { CronTaskType } from '../../cronjob/types.js'

export function createCronjobTools(scheduler: CronScheduler): RegisteredTool[] {
  const store = scheduler.getStore()

  // ==================== 1. 创建定时任务 ====================

  const createCronjob: RegisteredTool = {
    name: 'create_cronjob',
    description: [
      '创建一个定时任务。',
      '任务类型：',
      '- agent_prompt: 定时让 Agent 执行一段 prompt（最灵活，可搜索新闻、生成报告等）',
      '- feishu_notify: 定时发送飞书通知（支持模板变量或让 Agent 动态生成）',
      '- custom_script: 定时执行 shell 命令',
      '',
      'cron 表达式格式：分 时 日 月 周几',
      '示例: "0 9 * * *"(每天9点) "0 9 * * 1-5"(工作日9点) "*/30 * * * *"(每30分钟)',
      '预设: @hourly @daily @weekly @monthly',
      '',
      'taskConfig 是 JSON 字符串，必须包含 type 字段：',
      '- agent_prompt: {"type":"agent_prompt","prompt":"要执行的指令"}',
      '- feishu_notify: {"type":"feishu_notify","messageTemplate":"消息模板"} 或 {"type":"feishu_notify","agentPrompt":"让Agent生成的指令"}',
      '- custom_script: {"type":"custom_script","command":"shell命令"}',
      '不要使用 feishu-cli 发送飞书通知，cronjob 已经支持了。',
    ].join('\n'),
    inputSchema: {
      name: z.string().describe('任务名称，如 "每日科技早报"'),
      cron: z.string().describe('cron 表达式，如 "0 9 * * 1-5" 或 @daily'),
      taskType: z.enum(['agent_prompt', 'feishu_notify', 'custom_script']).describe('任务类型'),
      taskConfig: z.string().describe('任务配置 JSON 字符串'),
      chatId: z.string().describe('执行结果发送到的飞书会话 ID（通常是当前会话的 chatId）'),
    },
    execute: async (args) => {
      try {
        const config = JSON.parse(args.taskConfig)
        config.type = args.taskType

        const job = store.createJob({
          name: args.name,
          cron: args.cron,
          taskType: args.taskType as CronTaskType,
          taskConfig: config,
          notifyChatId: args.chatId,
          enabled: true,
        })

        const nextRun = scheduler.getNextRunTime(job)
        const nextRunStr = nextRun
          ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '计算中'

        return {
          success: true,
          output: [
            '✅ 定时任务创建成功',
            `📌 名称: ${job.name}`,
            `🔑 ID: ${job.id}`,
            `⏰ 表达式: ${job.cron}`,
            `📋 类型: ${job.taskType}`,
            `📅 下次执行: ${nextRunStr}`,
          ].join('\n'),
        }
      } catch (error) {
        return {
          success: false,
          error: `创建失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 2. 查看定时任务列表 ====================

  const listCronjobs: RegisteredTool = {
    name: 'list_cronjobs',
    description: '列出所有定时任务，包括名称、cron 表达式、启用状态、上次执行时间和下次执行时间',
    inputSchema: {
      enabledOnly: z.boolean().optional().describe('是否只显示启用的任务，默认显示全部'),
    },
    execute: async (args) => {
      try {
        const jobs = store.listJobs(args.enabledOnly ?? false)
        if (jobs.length === 0) {
          return { success: true, output: '📋 暂无定时任务' }
        }

        const lines = jobs.map((job, i) => {
          const statusIcon = job.enabled ? '🟢' : '🔴'
          const lastRun = job.lastRunAt
            ? new Date(job.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : '从未执行'
          const lastStatus = job.lastRunStatus
            ? (job.lastRunStatus === 'success' ? '✅' : '❌')
            : '-'
          const nextRun = scheduler.getNextRunTime(job)
          const nextRunStr = nextRun
            ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : '-'

          return [
            `${i + 1}. ${statusIcon} **${job.name}**`,
            `   ID: ${job.id}`,
            `   Cron: \`${job.cron}\` | 类型: ${job.taskType}`,
            `   上次: ${lastRun} ${lastStatus} | 下次: ${nextRunStr}`,
          ].join('\n')
        })

        return {
          success: true,
          output: `📋 定时任务列表（共 ${jobs.length} 个）\n\n${lines.join('\n\n')}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 3. 管理定时任务 ====================

  const manageCronjob: RegisteredTool = {
    name: 'manage_cronjob',
    description: '管理定时任务：启用(enable)、禁用(disable)、删除(delete)、手动触发(trigger)',
    inputSchema: {
      jobId: z.string().describe('任务 ID'),
      action: z.enum(['enable', 'disable', 'delete', 'trigger']).describe('操作类型'),
    },
    execute: async (args) => {
      try {
        const { jobId, action } = args
        const job = store.getJob(jobId)
        if (!job) {
          return { success: false, error: `任务不存在: ${jobId}` }
        }

        switch (action) {
          case 'enable': {
            store.updateJob(jobId, { enabled: true })
            const nextRun = scheduler.getNextRunTime({ ...job, enabled: true })
            const nextRunStr = nextRun
              ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
              : '-'
            return { success: true, output: `✅ 任务 [${job.name}] 已启用，下次执行: ${nextRunStr}` }
          }
          case 'disable':
            store.updateJob(jobId, { enabled: false })
            return { success: true, output: `⏸️ 任务 [${job.name}] 已禁用` }
          case 'delete':
            store.deleteJob(jobId)
            return { success: true, output: `🗑️ 任务 [${job.name}] 已删除` }
          case 'trigger':
            await scheduler.triggerJob(jobId)
            return { success: true, output: `🚀 任务 [${job.name}] 已手动触发执行` }
          default:
            return { success: false, error: `未知操作: ${action}` }
        }
      } catch (error) {
        return {
          success: false,
          error: `操作失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 4. 查看执行日志 ====================

  const getCronjobLogs: RegisteredTool = {
    name: 'get_cronjob_logs',
    description: '查看指定定时任务的执行日志，包括执行时间、状态、耗时、结果或错误信息',
    inputSchema: {
      jobId: z.string().describe('任务 ID'),
      limit: z.number().optional().describe('返回条数，默认 10'),
    },
    execute: async (args) => {
      try {
        const job = store.getJob(args.jobId)
        const jobName = job?.name || args.jobId

        const logs = store.getJobLogs(args.jobId, args.limit ?? 10)
        if (logs.length === 0) {
          return { success: true, output: `📜 任务 [${jobName}] 暂无执行记录` }
        }

        const statusIcons: Record<string, string> = {
          success: '✅',
          failed: '❌',
          timeout: '⏱️',
        }

        const lines = logs.map((log, i) => {
          const icon = statusIcons[log.status] || '❓'
          const time = new Date(log.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          const duration = `${((log.finishedAt - log.startedAt) / 1000).toFixed(1)}s`
          const detail = log.error
            ? `错误: ${log.error}`
            : log.result
              ? `结果: ${log.result.slice(0, 100)}${log.result.length > 100 ? '...' : ''}`
              : ''

          return `${i + 1}. ${icon} ${time} | 耗时 ${duration}${detail ? `\n   ${detail}` : ''}`
        })

        return {
          success: true,
          output: `📜 任务 [${jobName}] 执行日志（最近 ${logs.length} 条）\n\n${lines.join('\n')}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  return [createCronjob, listCronjobs, manageCronjob, getCronjobLogs]
}
