import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig, AgentResponse, EventHandlers } from '../types/agent'

export class ClaudeEngine {
  private config: AgentConfig

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || '',
      model: config.model || process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
      maxTokens: config.maxTokens || 10000,
      temperature: config.temperature || 0.7,
      systemPrompt: config.systemPrompt || 'You are a helpful AI assistant.',
    }
  }

  /**
   * 获取Claude Agent SDK配置
   */
  private getClaudeAgentConfig() {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY || '1',
      http_proxy: '',
      https_proxy: '',
    }
    return {
      model: this.config.model,
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
      const { model, env } = this.getClaudeAgentConfig()

      // 构建用户查询文本
      const userQuery = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return `${msg.role}: ${msg.content}`
        }
        return `${msg.role}: [complex content]`
      }).join('\n')
      console.log('userQuery:', toolsConfig)
      // 使用异步生成器作为提示
      const response = query({
        prompt: userQuery,
        options: {
          ...toolsConfig,
          systemPrompt: this.config.systemPrompt,
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
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
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

      const { model, env } = this.getClaudeAgentConfig()

      // 构建工具配置
      const toolOptions: any = {
        systemPrompt: this.config.systemPrompt,
        model,
        settingSources: ['project'],
        cwd: process.cwd(),
        env,
      }

      // 如果有工具配置，则设置MCP服务器和允许的工具
      if (toolsConfig) {
        toolOptions.mcpServers = toolsConfig.mcpServers
        toolOptions.allowedTools = toolsConfig.allowedTools
      } else {
        toolOptions.allowedTools = []
      }

      // 构建用户查询文本
      const userQuery = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return `${msg.role}: ${msg.content}`
        }
        return `${msg.role}: [complex content]`
      }).join('\n')

      // 使用异步生成器作为提示
      const response = query({
        prompt: userQuery,
        options: toolOptions,
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
        throw new Error('AI响应为空')
      }

      return result
    } catch (error) {
      console.error('Claude流式引擎错误:', error)
      await eventHandlers?.onError?.(`Claude流式API调用失败: ${error instanceof Error ? error.message : '未知错误'}`)
      throw error
    }
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...newConfig }
  }

  /**
   * 获取当前配置
   */
  getConfig(): AgentConfig {
    return { ...this.config }
  }
}