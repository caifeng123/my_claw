import { Hono } from 'hono'
import { AgentEngine } from '../core/agent'

const agentRouter = new Hono()
const agentEngine = new AgentEngine()

// 创建新会话
agentRouter.post('/sessions', async (c) => {
  try {
    const { sessionId, userId } = await c.req.json()

    if (!sessionId) {
      return c.json({ error: 'sessionId is required' }, 400)
    }

    const session = agentEngine.getSession(sessionId)
    if (session) {
      return c.json({
        message: 'Session already exists',
        session
      })
    }

    const newSession = agentEngine.getSession(sessionId) ||
      agentEngine.createSession({ sessionId, userId })

    return c.json({
      message: 'Session created successfully',
      session: newSession
    })
  } catch (error) {
    console.error('Session creation error:', error)
    return c.json({ error: 'Failed to create session' }, 500)
  }
})

// 发送消息
agentRouter.post('/sessions/:sessionId/messages', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const { message, userId, stream } = await c.req.json()

    if (!message) {
      return c.json({ error: 'message is required' }, 400)
    }

    if (stream) {
      // 流式响应
      const stream = new ReadableStream({
        start(controller) {
          const eventHandlers = agentEngine.createHTTPStreamHandler((chunk) => {
            controller.enqueue(new TextEncoder().encode(chunk))
          })

          agentEngine.sendMessageStream(sessionId, message, userId, eventHandlers)
            .then(() => {
              controller.close()
            })
            .catch(error => {
              controller.error(error)
            })
        }
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
        },
      })
    } else {
      // 普通响应
      const response = await agentEngine.sendMessage(sessionId, message, userId)
      return c.json(response)
    }
  } catch (error) {
    console.error('Message sending error:', error)
    return c.json({ error: 'Failed to send message' }, 500)
  }
})

// 获取会话信息
agentRouter.get('/sessions/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const session = agentEngine.getSession(sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    return c.json({ session })
  } catch (error) {
    console.error('Session retrieval error:', error)
    return c.json({ error: 'Failed to retrieve session' }, 500)
  }
})

// 删除会话
agentRouter.delete('/sessions/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const deleted = agentEngine.deleteSession(sessionId)

    if (!deleted) {
      return c.json({ error: 'Session not found' }, 404)
    }

    return c.json({ message: 'Session deleted successfully' })
  } catch (error) {
    console.error('Session deletion error:', error)
    return c.json({ error: 'Failed to delete session' }, 500)
  }
})

// 获取会话统计
agentRouter.get('/sessions', async (c) => {
  try {
    const stats = agentEngine.getSessionStats()
    return c.json({ stats })
  } catch (error) {
    console.error('Stats retrieval error:', error)
    return c.json({ error: 'Failed to retrieve stats' }, 500)
  }
})

// 注册工具
agentRouter.post('/tools', async (c) => {
  try {
    const toolOptions = await c.req.json()
    agentEngine.registerTool(toolOptions)

    return c.json({ message: 'Tool registered successfully' })
  } catch (error) {
    console.error('Tool registration error:', error)
    return c.json({ error: 'Failed to register tool' }, 500)
  }
})

// 获取工具列表
agentRouter.get('/tools', async (c) => {
  try {
    const toolNames = agentEngine.getToolNames()
    return c.json({ tools: toolNames })
  } catch (error) {
    console.error('Tools retrieval error:', error)
    return c.json({ error: 'Failed to retrieve tools' }, 500)
  }
})

export default agentRouter