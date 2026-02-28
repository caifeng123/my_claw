import dotenv from 'dotenv'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import agentRouter from './routes/agent'
import feishuRouter from './routes/feishu.js'
import memoryRouter from './routes/memory.js'
import { agentEngine } from './core/agent'
import { getFeishuConfig, validateFeishuConfig } from './config/feishu.js'
import { startDefaultFeishuBridge, stopDefaultFeishuBridge } from './services/feishu/feishu-agent-bridge.js'

const app = new Hono()
dotenv.config();

// 初始化工具配置
agentEngine.initializeTools().then(() => {
  console.log('🔧 工具配置初始化完成')
}).catch(error => {
  console.error('❌ 工具配置初始化失败:', error)
})

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

// 健康检查端点
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Agent API 路由
app.route('/api/agent', agentRouter)

// 飞书 API 路由
app.route('/api/feishu', feishuRouter)

// Memory API 路由
app.route('/api/memory', memoryRouter)

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

// 服务器启动函数
async function startServer() {
  // 初始化飞书服务
  await initializeFeishuService()

  console.log(`🚀 cf_claw server starting on port ${port}...`)

  // 优雅关闭处理
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

  return {
    port,
    fetch: app.fetch
  }
}

// 导出启动函数
export default startServer()