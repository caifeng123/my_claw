import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResponse, EventHandlers } from '../types/agent'

export class ClaudeEngine {
  private config: {
    model: string
    env: Record<string, any>
  }

  constructor() {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY || '1',
      http_proxy: '',
      https_proxy: '',
    }
    this.config = {
      model: process.env.CLAUDE_MODEL || '',
      env,
    }
  }

  /**
   * 发送消息给Claude并获取响应
   */
  async sendMessage(
    messages: any[],
    toolsConfig?: { mcpServers: any; allowedTools: string[] },
  ): Promise<AgentResponse> {
    try {
      const { model, env } = this.config

      // 构建用户查询文本
      const userQuery = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return `${msg.role}: ${msg.content}`
        }
        // 处理数组类型的 content
        if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n')
          return `${msg.role}: ${textParts || '[non-text content]'}`
        }
        return `${msg.role}: [complex content]`
      }).join('\n')

      // 使用异步生成器作为提示
      const response = query({
        prompt: userQuery,
        options: {
          ...toolsConfig,
          // systemPrompt: this.config.systemPrompt,
          model,
          settingSources: ['project'],
          cwd: process.cwd(),
          env,
        },
      })

      let result = ''
      let resume = ''

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          resume = message.session_id
          result += (message as any).result
        } else if (message.type === 'assistant') {
          // 处理assistant消息
          console.log('Assistant message:', message?.message?.content)
        }
      }

      if (!result.trim()) {
        throw new Error('AI响应为空')
      }

      return {
        content: result,
      }
    } catch (error) {
      console.error('Claude引擎错误:', error)
      throw new Error(`Claude API调用失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * 流式发送消息给Claude
   */
  async sendMessageStream(
    messages: any[],
    toolsConfig?: { mcpServers: any; allowedTools: string[] },
    eventHandlers?: EventHandlers
  ): Promise<string> {
    try {
      await eventHandlers?.onContentStart?.()

      const { model, env } = this.config

      const userQuery = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return `${msg.role}: ${msg.content}`
        }
        // 处理数组类型的 content
        if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n')
          return `${msg.role}: ${textParts || '[non-text content]'}`
        }
        return `${msg.role}: [complex content]`
      }).join('\n')

      // 使用异步生成器作为提示
      const response = query({
        prompt: userQuery,
        options: {
          ...toolsConfig,
          // systemPrompt: this.config.systemPrompt,
          model,
          settingSources: ['project'],
          cwd: process.cwd(),
          env,
        },
      })

      let result = ''

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          const messageResult = (message as any).result
          result += messageResult
          await eventHandlers?.onContentDelta?.(messageResult)
        } else if (message.type === 'assistant') {
          // 处理assistant消息
          console.log('Assistant message:', message?.message?.content)
        }
      }

      await eventHandlers?.onContentStop?.()

      if (!result.trim()) {
        // throw new Error('AI响应为空')
      }

      return result
    } catch (error) {
      console.error('Claude流式引擎错误:', error)
      await eventHandlers?.onError?.(`Claude流式API调用失败: ${error instanceof Error ? error.message : '未知错误'}`)
      throw error
    }
  }
}