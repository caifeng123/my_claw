import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResponse, EventHandlers } from '../types/agent'
import { ToolManager } from './tool-manager'

export class ClaudeEngine {
  private config: {
    model: string
    env: Record<string, any>
  }
  toolManager: ToolManager

  constructor() {
    this.toolManager = new ToolManager()
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
  async sendMessage(messages: any[]): Promise<AgentResponse> {
    try {
      const { model, env } = this.config
      const toolsConfig = await this.toolManager.getTools()

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
      let lastAssistantContent = ''  // 临时存储最后一个 assistant 消息

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          resume = message.session_id
          result += (message as any).result
        } else if (message.type === 'assistant') {
          // 提取 assistant 消息内容并存储
          const assistantContent = message?.message?.content
          if (assistantContent) {
            // content 可能是数组格式，需要提取文本
            const textContent = Array.isArray(assistantContent)
              ? assistantContent.filter(c => c.type === 'text').map(c => c.text).join('')
              : String(assistantContent)
            lastAssistantContent = textContent
            console.log('Assistant message:', assistantContent)
          }
        }
      }

      // 如果 result 为空，使用最后一个 assistant 消息
      if (!result.trim() && lastAssistantContent) {
        result = lastAssistantContent
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
    eventHandlers?: EventHandlers
  ): Promise<string> {
    try {
      await eventHandlers?.onContentStart?.()
      const toolsConfig = await this.toolManager.getTools()

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
      let lastAssistantContent = ''  // 临时存储最后一个 assistant 消息

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          const messageResult = (message as any).result
          result += messageResult
          await eventHandlers?.onContentDelta?.(messageResult)
        } else if (message.type === 'assistant') {
          // 提取 assistant 消息内容并存储
          const assistantContent = message?.message?.content
          if (assistantContent) {
            // content 可能是数组格式，需要提取文本
            const textContent = Array.isArray(assistantContent)
              ? assistantContent.filter(c => c.type === 'text').map(c => c.text).join('')
              : String(assistantContent)
            lastAssistantContent = textContent
            console.log('Assistant message:', assistantContent)
          }
        }
      }

      await eventHandlers?.onContentStop?.()

      // 如果 result 为空，使用最后一个 assistant 消息
      if (!result.trim() && lastAssistantContent) {
        result = lastAssistantContent
        // 主动触发 onContentDelta，确保飞书能收到这个内容
        await eventHandlers?.onContentDelta?.(result)
      }

      return result
    } catch (error) {
      console.error('Claude流式引擎错误:', error)
      await eventHandlers?.onError?.(`Claude流式API调用失败: ${error instanceof Error ? error.message : '未知错误'}`)
      throw error
    }
  }

  /**
   * 原始查询Claude API
   */
  public async executeClaudeQueryRaw(
    systemPrompt: string,
    userQuery: string,
    options: Options = {}
  ): Promise<{ result: string; resume: string }> {
    const { model, env } = this.config

    const toolsConfig = await this.toolManager.getTools()
    // const startTime = Date.now();
    try {
      const response = query({
        prompt: userQuery,
        options: {
          ...toolsConfig,
          systemPrompt,
          model,
          settingSources: ['project'],
          cwd: process.cwd(),
          env,
          ...options,
        },
      });

      let result = '';
      let resume = '';

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          resume = message.session_id;
          result += (message as any).result;
        } else if (message.type === 'assistant') {
          // console.log(message?.message?.content);
        }
      }

      if (!result.trim()) {
        throw new Error('AI响应为空');
      }

      return { result, resume };
    } catch (error) {
      throw new Error(`AI查询失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      // console.log(`Claude API调用耗时: ${(Date.now() - startTime) / 1000}s`);
    }
  }
}