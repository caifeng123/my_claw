/**
 * CronJob 任务执行器
 * 
 * 按 taskType 分发执行，执行完毕后：
 * 1. 更新任务的 lastRunAt / lastRunStatus
 * 2. 追加执行日志
 * 3. 将结果发送到飞书 chatId（直接发到 chat 顶层，不回话题）
 */

import type { CronJob } from './types.js'
import type { CronStore } from './cron-store.js'
import { getAgentEngine } from '../agent-registry.js'
import { getDefaultFeishuAgentBridge } from '../../services/feishu/feishu-agent-bridge.js'
import { execSync } from 'child_process'

export class CronExecutor {
  private store: CronStore

  constructor(store: CronStore) {
    this.store = store
  }

  /**
   * 执行一个 CronJob
   */
  async execute(job: CronJob): Promise<void> {
    console.log(`⏰ 执行定时任务: [${job.name}] (${job.id})`)
    const startedAt = Date.now()

    try {
      const result = await this.dispatch(job)
      const finishedAt = Date.now()

      // 更新任务状态
      this.store.updateJob(job.id, {
        lastRunAt: finishedAt,
        lastRunStatus: 'success',
      })

      // 追加日志
      this.store.appendLog({
        jobId: job.id,
        jobName: job.name,
        startedAt,
        finishedAt,
        status: 'success',
        result: typeof result === 'string' ? result.slice(0, 500) : undefined,
      })

      console.log(`✅ 定时任务完成: [${job.name}] 耗时 ${((finishedAt - startedAt) / 1000).toFixed(1)}s`)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '未知错误'
      const finishedAt = Date.now()

      // 更新任务状态
      this.store.updateJob(job.id, {
        lastRunAt: finishedAt,
        lastRunStatus: 'failed',
      })

      // 追加日志
      this.store.appendLog({
        jobId: job.id,
        jobName: job.name,
        startedAt,
        finishedAt,
        status: 'failed',
        error: errMsg.slice(0, 500),
      })

      // 失败也通知飞书（self_iteration 无 chatId 则跳过）
      if (job.notifyChatId) {
        await this.notify(job.notifyChatId, `❌ 定时任务 [${job.name}] 执行失败:\n${errMsg}`)
      }

      console.error(`❌ 定时任务失败: [${job.name}]`, error)
    }
  }

  /**
   * 按 taskType 分发
   */
  private async dispatch(job: CronJob): Promise<string> {
    switch (job.taskConfig.type) {
      case 'agent_prompt':
        return await this.executeAgentPrompt(job)
      case 'feishu_notify':
        return await this.executeFeishuNotify(job)
      case 'custom_script':
        return await this.executeCustomScript(job)
      case 'self_iteration':
        return await this.executeSelfIteration(job)
      default:
        throw new Error(`未知任务类型: ${(job.taskConfig as any).type}`)
    }
  }

  /**
   * agent_prompt: 让 Agent 执行 prompt，结果推飞书
   */
  private async executeAgentPrompt(job: CronJob): Promise<string> {
    const config = job.taskConfig as import('./types.js').AgentPromptConfig
    const sessionId = `cron_${job.id}_${Date.now()}`

    // 注入时间上下文
    const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const enrichedPrompt = `[系统：这是定时任务「${job.name}」的自动执行，当前时间 ${timeStr}]\n\n${config.prompt}`

    const engine = getAgentEngine()
    const response = await engine.sendMessage(sessionId, enrichedPrompt)

    // 推送结果到飞书
    await this.notify(job.notifyChatId, response.content)

    // 清理临时 session
    engine.deleteSession(sessionId)

    return response.content
  }

  /**
   * feishu_notify: 定时飞书通知
   */
  private async executeFeishuNotify(job: CronJob): Promise<string> {
    const config = job.taskConfig as import('./types.js').FeishuNotifyConfig
    let message: string

    if (config.agentPrompt) {
      // 动态模式：让 Agent 生成消息
      const sessionId = `cron_notify_${job.id}_${Date.now()}`
      const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      const engine = getAgentEngine()
      const response = await engine.sendMessage(
        sessionId,
        `[系统：这是定时通知任务「${job.name}」，当前时间 ${timeStr}]\n\n${config.agentPrompt}`
      )
      message = response.content
      engine.deleteSession(sessionId)
    } else if (config.messageTemplate) {
      // 静态模板
      message = this.renderTemplate(config.messageTemplate)
    } else {
      throw new Error('feishu_notify 必须配置 messageTemplate 或 agentPrompt')
    }

    await this.notify(job.notifyChatId, message)
    return message
  }

  /**
   * custom_script: 执行 shell 命令
   */
  private async executeCustomScript(job: CronJob): Promise<string> {
    const config = job.taskConfig as import('./types.js').CustomScriptConfig
    const timeout = config.timeout || 30000

    const output = execSync(config.command, {
      encoding: 'utf-8',
      timeout,
    }).trim()

    // 推送结果
    const message = `🔧 脚本任务 [${job.name}] 执行完成:\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``
    await this.notify(job.notifyChatId, message)

    return output
  }

  /**
   * self_iteration: Skill 自迭代 — 分析 traces，提炼知识，按需优化 SKILL.md
   */
  private async executeSelfIteration(job: CronJob): Promise<string> {
    const config = job.taskConfig as import('./types.js').SelfIterationTaskConfig

    // 动态 import 避免循环依赖
    const { IterationChecker } = await import('../self-iteration/iteration-checker.js')
    const { ClaudeEngine } = await import('../agent/engine/claude-engine.js')

    // 创建独立 ClaudeEngine 实例（不污染主会话）
    const engine = new ClaudeEngine()
    const checker = new IterationChecker(engine)

    console.log(`🌙 [CronExecutor] Starting self-iteration: skills=${JSON.stringify(config.skills)}`)

    const report = await checker.runNightly(config.skills)

    // 构建摘要
    const lines: string[] = [
      `🌙 Skill 自迭代报告 (${report.runAt})`,
      '',
    ]

    for (const skill of report.skills) {
      const icon = skill.action === 'optimized' ? '🔧' :
                   skill.action === 'analyzed' ? '📊' :
                   skill.action === 'error' ? '❌' : '⏭️'
      lines.push(`${icon} **${skill.skillName}**: ${skill.action} (${skill.tracesAnalyzed} traces) — ${skill.reason}`)
    }

    if (report.skills.length === 0) {
      lines.push('No skills with traces found.')
    }

    const summary = lines.join('\n')

    // 如果配置了 notifyChatId，推送报告到飞书
    if (job.notifyChatId) {
      await this.notify(job.notifyChatId, summary)
    }

    return summary
  }

  /**
   * 发送飞书消息（直接发到 chat 顶层，不回话题）
   */
  private async notify(chatId: string, text: string): Promise<void> {
    if (!chatId) return
    try {
      const bridge = getDefaultFeishuAgentBridge()
      if (bridge?.isBridgeConnected()) {
        await bridge.sendMessageToChat(chatId, text)
      } else {
        console.warn('⚠️ 飞书服务未连接，无法发送定时任务结果')
      }
    } catch (error) {
      console.error('❌ 发送飞书通知失败:', error)
    }
  }

  /**
   * 渲染消息模板变量
   */
  private renderTemplate(template: string): string {
    const now = new Date()
    const opts = { timeZone: 'Asia/Shanghai' } as const

    const shanghaiDay = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
    ).getDay()

    return template
      .replace(/\{\{date\}\}/g, now.toLocaleDateString('zh-CN', opts))
      .replace(/\{\{time\}\}/g, now.toLocaleTimeString('zh-CN', opts))
      .replace(/\{\{datetime\}\}/g, now.toLocaleString('zh-CN', opts))
      .replace(/\{\{weekday\}\}/g, ['日', '一', '二', '三', '四', '五', '六'][shanghaiDay] as string)
  }
}
