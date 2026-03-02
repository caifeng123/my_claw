import dotenv from 'dotenv'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import agentRouter from './routes/agent'
import feishuRouter from './routes/feishu.js'
import memoryRouter from './routes/memory.js'
import { agentEngine } from './core/agent'
import { getFeishuConfig, validateFeishuConfig } from './config/feishu.js'
import { startDefaultFeishuBridge, stopDefaultFeishuBridge, getDefaultFeishuAgentBridge } from './services/feishu/feishu-agent-bridge.js'

// 状态文件路径（与 launcher.ts 保持一致）
const STATE_FILE = '.restart-state.json'

// 重启状态接口
interface RestartState {
  chatIds: string[]
  messageIds: string[]
  status: 'restarting' | 'rollback' | 'success'
  timestamp: number
  error?: string
  hasConflict?: boolean
}

const app = new Hono()
dotenv.config();

// 初始化飞书服务
async function initializeFeishuService() {
  const feishuConfig = getFeishuConfig()
  const validation = validateFeishuConfig(feishuConfig)

  if (!validation.valid) {
    console.warn('⚠️ 飞书配置验证失败:', validation.errors.join(', '))
    return false
  }

  if (!feishuConfig.enabled) {
    console.log('ℹ️ 飞书集成已禁用，跳过初始化')
    return false
  }

  console.log('🚀 初始化飞书Agent桥接服务...')

  try {
    const success = await startDefaultFeishuBridge({
      feishu: {
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
      },
      ...feishuConfig.bridge,
    })

    if (success) {
      console.log('✅ 飞书Agent桥接服务启动成功')
    } else {
      console.error('❌ 飞书Agent桥接服务启动失败')
    }

    return success
  } catch (error) {
    console.error('❌ 飞书服务初始化失败:', error)
    return false
  }
}

// 中间件
app.use('*', logger())
app.use('*', cors())

// 健康检查路由
app.get('/', (c) => {
  return c.json({
    message: 'cf_claw API Server',
    version: '0.1.0',
    status: 'running'
  })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 路由
app.route('/api/agent', agentRouter)
app.route('/api/feishu', feishuRouter)
app.route('/api/memory', memoryRouter)

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

/**
 * 检查并处理重启状态文件
 * 如果存在状态文件且为最终状态，向用户发送重启结果通知
 */
async function handleRestartState(): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    return
  }

  console.log('📄 发现重启状态文件，处理中...')

  try {
    const content = readFileSync(STATE_FILE, 'utf-8')
    const state: RestartState = JSON.parse(content)

    // 只处理最终状态（success / rollback），restarting 说明还在流程中
    if (state.status === 'restarting') {
      console.log('ℹ️ 状态为 restarting，等待 launcher 更新...')
      return
    }

    const bridge = getDefaultFeishuAgentBridge()
    if (!bridge || !bridge.isBridgeConnected()) {
      console.warn('⚠️ 飞书服务未连接，无法发送重启通知')
      return
    }

    // 构建通知消息
    let message = ''
    if (state.status === 'success') {
      message = '✅ 服务重启成功！新代码已生效。'
    } else if (state.status === 'rollback') {
      message = `⚠️ 服务重启失败，已自动回滚到旧版本。\n\n错误信息：${state.error || '未知错误'}\n\n请修复代码后重新尝试 /restart`
    }

    // 向所有记录的对话发送通知
    const notifiedChatIds = new Set<string>()

    for (let i = 0; i < state.chatIds.length; i++) {
      const chatId = state.chatIds[i]
      const messageId = state.messageIds[i]

      if (!chatId || notifiedChatIds.has(chatId)) continue
      notifiedChatIds.add(chatId)

      try {
        await bridge.sendMessageToChat(chatId, message, messageId)
        console.log(`✅ 已发送重启通知到 chat ${chatId}`)
      } catch (err) {
        console.error(`❌ 发送通知到 chat ${chatId} 失败:`, err)
      }
    }

    unlinkSync(STATE_FILE)
    console.log('📄 状态文件已删除')
  } catch (error) {
    console.error('❌ 处理重启状态文件失败:', error)
  }
}

/**
 * 监听来自 launcher 的消息
 */
function setupIpcListener(): void {
  if (!process.send) return

  process.on('message', (msg: any) => {
    if (!msg || typeof msg !== 'object') return

    switch (msg.type) {
      case 'state':
        console.log('📨 收到 launcher 状态更新:', msg.state?.status)
        handleRestartState()
        break
      default:
        console.log('📨 收到 launcher 消息:', msg)
    }
  })
}

async function startServer() {
  await initializeFeishuService()

  console.log(`🚀 cf_claw server starting on port ${port}...`)

  process.on('SIGINT', async () => {
    console.log('\n🛑 收到关闭信号，正在优雅关闭...')
    await stopDefaultFeishuBridge()
    console.log('✅ 服务已关闭')
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\n🛑 收到终止信号，正在优雅关闭...')
    await stopDefaultFeishuBridge()
    console.log('✅ 服务已关闭')
    process.exit(0)
  })

  return { port, fetch: app.fetch }
}

async function main() {
  setupIpcListener()
  await startServer()

  // 先通知 launcher 已就绪（launcher 会 stash pop + 更新状态为 success）
  if (process.send) {
    process.send({ type: 'ready' })
    console.log('📤 已发送 ready 信号给 launcher')
  }

  // 延迟处理状态文件，等 launcher 先完成 stash pop + 状态更新
  setTimeout(() => handleRestartState(), 5000)
}

main().catch((error) => {
  console.error('❌ 服务启动失败:', error)
  process.exit(1)
})