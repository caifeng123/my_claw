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
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    }
    
    this.config = {
      model: process.env.CLAUDE_MODEL || '',
      env,
    }
  }

  /**
   * 发送消息给Claude并获取响应（支持自定义 systemPrompt）
   */
  async sendMessage(messages: any[], systemPrompt?: string): Promise<AgentResponse> {
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
          ...(systemPrompt ? { systemPrompt } : {}),
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
   * 流式发送消息给Claude（支持自定义 systemPrompt）
   *
   * SDK 消息类型说明:
   *   - 'assistant' (SDKAssistantMessage): content 数组含 thinking/tool_use/text 块
   *   - 'user' (SDKUserMessage): parent_tool_use_id + tool_use_result 携带工具执行结果
   *   - 'tool_progress' (SDKToolProgressMessage): 工具执行中进度通知
   *   - 'result' (SDKResultMessage): 最终结果
   *   - 注意: SDK 中不存在 'tool_result' 类型
   *
   * result 推送策略:
   *   SDK 返回的 result.result 是最终完整回答，但流式过程中 text 块已通过
   *   onContentDelta 推送过部分/全部内容。如果 result 包含未推送过的新内容，
   *   需要补推以确保卡片展示完整回答。
   */
  async sendMessageStream(
    messages: any[],
    eventHandlers?: EventHandlers,
    systemPrompt?: string,
    abortController?: AbortController,
  ): Promise<string> {
    let result = ''
    // [FIX] 追踪已通过 onContentDelta 推送到卡片的全部内容
    let pushedContent = ''
    // [FIX] 收集所有 thinking 内容，用于在无 text 输出时作为生成回答的上下文
    let allThinkingContent = ''
    // [FIX] 追踪最后一个 thinking 块的内容，用于终极兜底（只返回最后一段 thinking）
    let lastThinkingContent = ''
    // tool_use_id → tool_name 映射，用于在 user 消息中查找工具名
    const toolUseIdToName = new Map<string, string>()

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
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(abortController ? { abortController } : {}),
          model,
          settingSources: ['project'],
          cwd: process.cwd(),
          env,
        },
      })

      // 处理AI响应流（abortController.abort() 会中断此循环）
      for await (const message of response) {
        if (message.type === 'result') {
          // ====== result 消息：最终结果 ======
          const resultMsg = message as any
          const messageResult = resultMsg.result

          if (messageResult && messageResult.trim()) {
            result = messageResult

            // [FIX] 检查 result 是否包含尚未推送的内容
            // 场景：text 块推了一句话"我来查询"，但 result 包含完整回答
            // 此时需要将 result 中未推送的部分补推到卡片
            if (pushedContent && messageResult.startsWith(pushedContent)) {
              // result 以已推送内容为前缀 → 只补推后面的增量
              const delta = messageResult.slice(pushedContent.length)
              if (delta.trim()) {
                await eventHandlers?.onContentDelta?.(delta)
                pushedContent += delta
              }
            } else if (!pushedContent) {
              // 从未推送过任何内容 → 完整推送 result
              await eventHandlers?.onContentDelta?.(messageResult)
              pushedContent = messageResult
            } else if (messageResult.length > pushedContent.length && messageResult !== pushedContent) {
              // result 不以已推送内容为前缀，但更长更完整
              // 说明 result 是重新组织的完整回答，与流式 text 块内容不一致
              // → 推送完整 result（卡片侧会追加，但这比丢失内容好）
              const delta = '\n\n' + messageResult
              await eventHandlers?.onContentDelta?.(delta)
              pushedContent += delta
            }
            // else: result 与已推送内容相同或更短 → 不重复推送
          }

        } else if (message.type === 'assistant') {
          // ====== assistant 消息：包含 thinking / text / tool_use 块 ======
          const msg = message?.message
          const assistantContent = msg?.content

          if (assistantContent && Array.isArray(assistantContent)) {
            // [FIX] 跟踪本轮 assistant 消息是否包含 thinking 块
            let hasThinkingInThisMessage = false

            for (const block of assistantContent) {
              // --- thinking 块 ---
              if (block.type === 'thinking' && block.thinking) {
                hasThinkingInThisMessage = true
                allThinkingContent += block.thinking  // [FIX] 累积所有 thinking 内容
                lastThinkingContent = block.thinking  // [FIX] 记录最后一个 thinking 块
                await eventHandlers?.onThinkingDelta?.(block.thinking)
              }

              // --- tool_use 块 ---
              if (block.type === 'tool_use') {
                // 记录 tool_use_id → tool_name 映射
                if (block.id && block.name) {
                  toolUseIdToName.set(block.id, block.name)
                }
                await eventHandlers?.onToolUseStart?.(block.name, block.input)
              }

              // --- text 块 ---
              if (block.type === 'text' && block.text) {
                // ✅ 触发内容增量事件
                await eventHandlers?.onContentDelta?.(block.text)
                pushedContent += block.text  // [FIX] 追踪已推送的内容
              }
            }
            // [FIX] 仅在本轮 assistant 消息确实包含 thinking 块时才触发 thinkingStop
            // 避免工具调用后的后续 assistant 消息误触发 thinkingStop
            if (hasThinkingInThisMessage) {
              await eventHandlers?.onThinkingStop?.()
            }
          }

        } else if (message.type === 'user') {
          // ====== user 消息：工具执行结果 ======
          const userMsg = message as any

          // 从 message.content 数组中提取所有 tool_result 条目
          const messageContent = userMsg.message?.content
          if (Array.isArray(messageContent)) {
            for (const entry of messageContent) {
              if (entry?.type === 'tool_result' && entry?.tool_use_id) {
                const toolUseId = entry.tool_use_id
                const toolName = toolUseIdToName.get(toolUseId) || 'unknown_tool'

                // 提取结果文本
                let resultContent: any
                if (Array.isArray(entry.content)) {
                  const textParts = entry.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text || '')
                  resultContent = textParts.length > 0
                    ? textParts.join('\n')
                    : JSON.stringify(entry.content).slice(0, 500)
                } else if (typeof entry.content === 'string') {
                  resultContent = entry.content
                } else {
                  resultContent = entry.content
                    ? JSON.stringify(entry.content).slice(0, 500)
                    : '(tool executed, no result captured)'
                }

                await eventHandlers?.onToolUseStop?.(toolName, resultContent)
              }
            }
          } else {
            // [FALLBACK] 旧路径: 尝试从顶层字段获取
            const parentToolUseId = userMsg.parent_tool_use_id
              ?? userMsg.message?.parent_tool_use_id

            const toolUseResult = userMsg.tool_use_result
              ?? userMsg.tool_result
              ?? userMsg.message?.tool_use_result
              ?? userMsg.message?.tool_result

            if (parentToolUseId) {
              const toolName = toolUseIdToName.get(parentToolUseId) || 'unknown_tool'
              let resultContent: any = toolUseResult ?? '(tool executed, no result captured)'

              if (Array.isArray(resultContent)) {
                const textParts = resultContent
                  .filter((b: any) => b.type === 'text' || b.type === 'tool_result')
                  .map((b: any) => b.text || b.content || JSON.stringify(b))
                resultContent = textParts.length > 0
                  ? textParts.join('\n')
                  : JSON.stringify(resultContent).slice(0, 500)
              } else if (typeof resultContent === 'object' && resultContent !== null) {
                if (resultContent.content && Array.isArray(resultContent.content)) {
                  const textParts = resultContent.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                  resultContent = textParts.length > 0
                    ? textParts.join('\n')
                    : JSON.stringify(resultContent).slice(0, 500)
                } else if (typeof resultContent.text === 'string') {
                  resultContent = resultContent.text
                } else {
                  resultContent = JSON.stringify(resultContent).slice(0, 500)
                }
              }

              await eventHandlers?.onToolUseStop?.(toolName, resultContent)
            }
          }
        }
        // 其他消息类型暂不处理
      }

      // [FIX] 终极兜底：如果没有任何 result 也没推送过任何内容，
      // 但有 thinking 内容 → 使用最后一段 thinking 作为降级回答
      if (!result.trim() && !pushedContent.trim() && lastThinkingContent.trim()) {
        result = lastThinkingContent
        await eventHandlers?.onContentDelta?.(lastThinkingContent)
      }

      // 确保 result 变量有值（用于返回给调用方）
      if (!result.trim() && pushedContent.trim()) {
        result = pushedContent
      }

      await eventHandlers?.onContentStop?.()
      return result

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      await eventHandlers?.onError?.(errMsg)
      throw error
    }
  }

  /**
   * 压缩查询内容（兼容旧接口）
   */
  async compressQuery(params: { systemPrompt: string; prompt: string; maxTokens: number }): Promise<string> {
    const result = await this.sendMessage(
      [{ role: 'user', content: params.prompt }],
      params.systemPrompt,
    )
    return result.content || ''
  }

  /**
   * 执行原始Claude查询（兼容旧接口）
   */
  async executeClaudeQueryRaw(systemPrompt: string, prompt: string): Promise<any> {
    return this.sendMessage(
      [{ role: 'user', content: prompt }],
      systemPrompt,
    )
  }
}
