import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResponse, EventHandlers, TokenUsageStats } from '../types/agent'
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
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '1',
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
   * 流式发送消息给Claude（支持自定义 systemPrompt）
   * V2: 新增 thinking / tool_use / usage 事件回调
   *
   * SDK 消息类型说明:
   *   - 'assistant' (SDKAssistantMessage): content 数组含 thinking/tool_use/text 块
   *   - 'user' (SDKUserMessage): parent_tool_use_id + tool_use_result 携带工具执行结果
   *   - 'tool_progress' (SDKToolProgressMessage): 工具执行中进度通知
   *   - 'result' (SDKResultMessage): 最终结果 + 权威 token 统计
   *   - 注意: SDK 中不存在 'tool_result' 类型
   */
  async sendMessageStream(
    messages: any[],
    eventHandlers?: EventHandlers,
    systemPrompt?: string,
    abortController?: AbortController,
  ): Promise<string> {
    let result = ''
    // [FIX] 追踪是否从 assistant 消息中收到过 text 块内容
    let hasReceivedTextContent = false
    // [FIX] 收集所有 thinking 内容，用于在无 text 输出时作为生成回答的上下文
    let allThinkingContent = ''
    // Token 用量累计（跨多个 assistant 消息）
    const usageAccum: TokenUsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    }
    // 用于按 message.id 去重（并行 tool_use 会产生同 id 的多条消息）
    const seenMessageIds = new Set<string>()
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

      let lastAssistantContent = ''  // 临时存储最后一个 assistant 消息

      // 处理AI响应流（abortController.abort() 会中断此循环）
      for await (const message of response) {
        if (message.type === 'result') {
          // ====== result 消息：最终结果 + 权威 token 统计 ======
          const resultMsg = message as any

          // ⭐ 深度调试：打印 result 消息所有顶层 key 和 usage 相关字段
          const topKeys = Object.keys(resultMsg)
          console.log('🔍 [ResultMsg] topKeys:', topKeys.join(', '))
          console.log('🔍 [ResultMsg] usage:', JSON.stringify(resultMsg.usage))
          console.log('🔍 [ResultMsg] modelUsage:', JSON.stringify(resultMsg.modelUsage))
          console.log('🔍 [ResultMsg] total_cost_usd:', resultMsg.total_cost_usd)
          console.log('🔍 [ResultMsg] num_turns:', resultMsg.num_turns)
          console.log('🔍 [ResultMsg] session_id:', resultMsg.session_id)
          // 打印 result 字段前 200 字符
          console.log('🔍 [ResultMsg] result(200):', String(resultMsg.result).slice(0, 200))

          const messageResult = resultMsg.result
          const stopReason = resultMsg.stop_reason
          const subtype = resultMsg.subtype
          console.log('🔍 [ResultMsg] subtype:', subtype, 'stop_reason:', stopReason)

          // [FIX] 智能决策：是否将 result 作为内容增量发送
          if (hasReceivedTextContent) {
            // 已从 assistant text 块收到内容 → 不重复发送 result（避免重复/thinking 污染）
            console.log('🔍 [ResultMsg] Skipping result delta (text already received via assistant blocks)')
            if (!result.trim()) result = messageResult
          } else if (messageResult && messageResult.trim()) {
            // 没收到过 text 内容，result 非空 → 用 result 兜底
            console.log('🔍 [ResultMsg] Using result as fallback content')
            result += messageResult
            await eventHandlers?.onContentDelta?.(messageResult)
          } else {
            // result 为空且没收到 text → 模型在最后一轮只输出了 thinking 就停止了
            // 需要将最后的 thinking 作为上下文，重新请求一次生成回答
            console.warn('⚠️ [ResultMsg] Empty result AND no text content from assistant! Last thinking may contain the answer context.')
          }

          // 提取 token 用量 — 三种策略
          // 策略 1: usage (BetaUsage 蛇形)
          if (resultMsg.usage && typeof resultMsg.usage === 'object') {
            const u = resultMsg.usage
            usageAccum.inputTokens = u.input_tokens || u.inputTokens || usageAccum.inputTokens
            usageAccum.outputTokens = u.output_tokens || u.outputTokens || usageAccum.outputTokens
            usageAccum.cacheReadTokens = u.cache_read_input_tokens || u.cacheReadInputTokens || usageAccum.cacheReadTokens
            usageAccum.cacheCreationTokens = u.cache_creation_input_tokens || u.cacheCreationInputTokens || usageAccum.cacheCreationTokens
          }

          // 策略 2: modelUsage (Record<string, ModelUsage> 驼峰)
          if (resultMsg.modelUsage && typeof resultMsg.modelUsage === 'object') {
            for (const modelKey of Object.keys(resultMsg.modelUsage)) {
              const mu = resultMsg.modelUsage[modelKey]
              if (mu) {
                usageAccum.inputTokens = mu.inputTokens || mu.input_tokens || usageAccum.inputTokens
                usageAccum.outputTokens = mu.outputTokens || mu.output_tokens || usageAccum.outputTokens
                usageAccum.cacheReadTokens = mu.cacheReadInputTokens || mu.cache_read_input_tokens || usageAccum.cacheReadTokens
                usageAccum.cacheCreationTokens = mu.cacheCreationInputTokens || mu.cache_creation_input_tokens || usageAccum.cacheCreationTokens
                if (mu.costUSD) usageAccum.totalCostUsd = mu.costUSD
                if (mu.cost_usd) usageAccum.totalCostUsd = mu.cost_usd
              }
            }
          }

          // 策略 3: total_cost_usd 权威计费
          if (resultMsg.total_cost_usd !== undefined && resultMsg.total_cost_usd > 0) {
            usageAccum.totalCostUsd = resultMsg.total_cost_usd
          }
          if (resultMsg.totalCostUsd !== undefined && resultMsg.totalCostUsd > 0) {
            usageAccum.totalCostUsd = resultMsg.totalCostUsd
          }

          await eventHandlers?.onUsageUpdate?.(usageAccum)

        } else if (message.type === 'assistant') {
          // ====== assistant 消息：包含 thinking / text / tool_use 块 ======
          console.log(message)
          const msg = message?.message
          const assistantContent = msg?.content
          const messageId = msg?.id

          // --- 按 message.id 去重提取 usage ---
          if (messageId && !seenMessageIds.has(messageId)) {
            seenMessageIds.add(messageId)
            const stepUsage = (msg as any)?.usage
            if (stepUsage) {
              // 同时兼容蛇形和驼峰
              usageAccum.inputTokens += stepUsage.input_tokens || stepUsage.inputTokens || 0
              usageAccum.outputTokens += stepUsage.output_tokens || stepUsage.outputTokens || 0
              usageAccum.cacheReadTokens += stepUsage.cache_read_input_tokens || stepUsage.cacheReadInputTokens || 0
              usageAccum.cacheCreationTokens += stepUsage.cache_creation_input_tokens || stepUsage.cacheCreationInputTokens || 0
            } else {
              console.log('🔍 [AssistantUsage] id=' + messageId + ' NO usage field. msg keys:', Object.keys(msg || {}).join(','))
            }
          }

          console.log('Assistant message:', assistantContent)

          if (assistantContent && Array.isArray(assistantContent)) {
            // [FIX] 跟踪本轮 assistant 消息是否包含 thinking 块
            let hasThinkingInThisMessage = false

            for (const block of assistantContent) {
              // --- thinking 块 ---
              if (block.type === 'thinking' && block.thinking) {
                hasThinkingInThisMessage = true
                allThinkingContent += block.thinking  // [FIX] 累积所有 thinking 内容
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
                lastAssistantContent = block.text
                hasReceivedTextContent = true  // [FIX] 标记已从 assistant text 块收到内容
                // ✅ 触发内容增量事件
                await eventHandlers?.onContentDelta?.(block.text)
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
          // [FIX V2] 基于实际日志确认的 SDK 消息结构进行解析
          // 实际结构: { type: 'user', message: { role: 'user', content: [{ tool_use_id, type: 'tool_result', content: [...] }] } }
          const userMsg = message as any
          const keys = Object.keys(userMsg).join(',')

          // [FIX V2] 从 message.content 数组中提取所有 tool_result 条目
          const messageContent = userMsg.message?.content
          if (Array.isArray(messageContent)) {
            // SDK 将工具结果放在 message.content 数组中，每个条目是一个 tool_result
            for (const entry of messageContent) {
              if (entry?.type === 'tool_result' && entry?.tool_use_id) {
                const toolUseId = entry.tool_use_id
                const toolName = toolUseIdToName.get(toolUseId) || 'unknown_tool'

                // 提取结果文本
                let resultContent: any
                if (Array.isArray(entry.content)) {
                  // content: [{ type: 'text', text: '...' }, ...]
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

            console.log(`🔧 [FALLBACK] User message: parent_tool_use_id=${parentToolUseId}, has_tool_result=${!!toolUseResult}, keys=${keys}`)

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

              console.log(`🔧 [FALLBACK] Resolved tool result: name=${toolName}, resultLen=${String(resultContent).length}`)
              await eventHandlers?.onToolUseStop?.(toolName, resultContent)
            } else {
              // 最终兜底: 既没有 message.content 数组，也没有 parent_tool_use_id
              console.warn(`⚠️ User message has no parseable tool result. keys=${keys}`)
              console.warn('⚠️ [DEBUG] User message FULL:', JSON.stringify(userMsg).slice(0, 1000))
            }
          }
        }
        // 其他消息类型暂不处理
      }

      // 如果 result 为空，使用最后一个 assistant 消息
      if (!result.trim() && lastAssistantContent) {
        result = lastAssistantContent
      }

      // [FIX] 终极兜底：如果 result 仍为空但有 thinking 内容，
      // 说明模型在最后一轮只输出了 thinking 没有生成 text 回答（SDK/模型边界情况）
      // 直接将最后一段 thinking 原文作为降级输出
      if (!result.trim() && allThinkingContent.trim()) {
        console.warn('⚠️ [FIX] No text output from model, falling back to last thinking content')
        result = allThinkingContent
        await eventHandlers?.onContentDelta?.(allThinkingContent)
      }

      await eventHandlers?.onContentStop?.(usageAccum)
      return result

    } catch (error) {
      console.error('❌ Claude引擎流式调用错误:', error)
      const errMsg = error instanceof Error ? error.message : String(error)
      await eventHandlers?.onError?.(errMsg)
      throw error
    }
  }

  /**
   * 压缩查询内容（兼容旧接口）
   */
  compressQuery(messages: any[]): any[] {
    return messages
  }

  /**
   * 执行原始Claude查询（兼容旧接口）
   */
  async executeClaudeQueryRaw(messages: any[], systemPrompt?: string): Promise<any> {
    return this.sendMessage(messages, systemPrompt)
  }
}