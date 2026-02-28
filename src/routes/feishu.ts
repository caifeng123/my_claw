import { Hono } from 'hono'
import { getDefaultFeishuAgentBridge } from '../services/feishu/feishu-agent-bridge.js'
import { getFeishuConfig, validateFeishuConfig } from '../config/feishu.js'

const feishuRouter = new Hono()

// 获取飞书服务状态
feishuRouter.get('/status', (c) => {
  const bridge = getDefaultFeishuAgentBridge()
  const config = getFeishuConfig()
  const validation = validateFeishuConfig(config)

  return c.json({
    enabled: config.enabled,
    connected: bridge ? bridge.isBridgeConnected() : false,
    configValid: validation.valid,
    configErrors: validation.errors,
    sessionStats: bridge ? bridge.getSessionStats() : null,
    timestamp: new Date().toISOString()
  })
})

// 获取飞书配置
feishuRouter.get('/config', (c) => {
  const config = getFeishuConfig()
  const validation = validateFeishuConfig(config)

  // 隐藏敏感信息
  const safeConfig = {
    ...config,
    appSecret: config.appSecret ? '***' + config.appSecret.slice(-4) : '',
  }

  return c.json({
    config: safeConfig,
    validation
  })
})

// 手动发送消息到飞书聊天
feishuRouter.post('/send-message', async (c) => {
  try {
    const { chatId, message } = await c.req.json()

    if (!chatId || !message) {
      return c.json({ error: 'chatId 和 message 参数是必需的' }, 400)
    }

    const bridge = getDefaultFeishuAgentBridge()
    if (!bridge || !bridge.isBridgeConnected()) {
      return c.json({ error: '飞书服务未连接' }, 503)
    }

    await bridge.sendMessageToChat(chatId, message)

    return c.json({
      success: true,
      message: '消息发送成功',
      chatId,
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('发送飞书消息失败:', error)
    return c.json({ error: '发送消息失败' }, 500)
  }
})

// 重启飞书服务
feishuRouter.post('/restart', async (c) => {
  try {
    const bridge = getDefaultFeishuAgentBridge()

    if (bridge) {
      await bridge.stop()
    }

    const config = getFeishuConfig()
    const validation = validateFeishuConfig(config)

    if (!validation.valid) {
      return c.json({
        success: false,
        error: '配置验证失败',
        details: validation.errors
      }, 400)
    }

    if (!config.enabled) {
      return c.json({
        success: false,
        error: '飞书集成已禁用'
      }, 400)
    }

    const newBridge = getDefaultFeishuAgentBridge({
      feishu: {
        appId: config.appId,
        appSecret: config.appSecret,
      },
      ...config.bridge,
    })

    const success = await newBridge.start()

    return c.json({
      success,
      message: success ? '飞书服务重启成功' : '飞书服务重启失败',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    console.error('重启飞书服务失败:', error)
    return c.json({
      success: false,
      error: '重启失败',
      details: error instanceof Error ? error.message : '未知错误'
    }, 500)
  }
})

export default feishuRouter