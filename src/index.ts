import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

const app = new Hono()

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

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

console.log(`🚀 cf_claw server starting on port ${port}...`)

// 导出类型化的服务器实例
export default {
  port,
  fetch: app.fetch
}