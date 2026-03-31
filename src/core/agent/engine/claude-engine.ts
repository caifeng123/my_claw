import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResponse, EventHandlers } from '../types/agent'
import { ToolManager } from './tool-manager'
import { SessionIdStore } from './session-id-store'
import { getVisionGuardConfig } from './vision-guard'

export class ClaudeEngine {
  private config: {
    model: string
    env: Record<string, any>
  }
  toolManager: ToolManager

  /** SDK session_id 持久化存储 */
  private sessionIdStore: SessionIdStore

  /** VisionGuard 配置 (三层防线) */
  private visionGuard = getVisionGuardConfig()

  constructor() {
    this.toolManager = new ToolManager()
    this.sessionIdStore = new SessionIdStore()
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
   * 获取 SessionIdStore（供外部模块使用）
   */
  getSessionIdStore(): SessionIdStore {
    return this.sessionIdStore
  }

  /**
   * 构建包含 VisionGuard 的 query options
   * 将三层防线注入到每次 query 调用中
   *
   * 改造点：
   * - 新增 sessionId 参数，用于自动设置 resume
   * - cwd 固定为 process.cwd()，确保 resume 路径一致
   */
  private buildQueryOptions(
    toolsConfig: Awaited<ReturnType<ToolManager['getTools']>>,
    systemPrompt?: string,
    abortController?: AbortController,
    sessionId?: string,
  ) {
    const { model, env } = this.config
    const guard = this.visionGuard

    // 合并 allowedTools: 原有工具 + Agent (Sub-Agent 必需)
    const allowedTools = [
      ...toolsConfig.allowedTools,
      ...guard.additionalAllowedTools,
    ]
    // 去重
    const uniqueAllowedTools = [...new Set(allowedTools)]

    // 层级一: 将图片处理规则追加到 system prompt
    const finalSystemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${guard.systemPromptRules}`
      : guard.systemPromptRules

    // [RESUME] 查找已有的 SDK session_id
    const sdkSessionId = sessionId ? this.sessionIdStore.get(sessionId) : undefined

    return {
      ...toolsConfig,
      allowedTools: uniqueAllowedTools,
      model,
      settingSources: ['project'] as Options['settingSources'],
      cwd: process.cwd(),
      env,

      // 层级一: System Prompt 引导
      ...(finalSystemPrompt ? { systemPrompt: finalSystemPrompt } : {}),

      // Vision Sub-Agent 定义 (haiku model, 独立上下文)
      agents: guard.agents,

      // 层级二: PreToolUse Hook 拦截 Read 图片
      hooks: guard.hooks,

      // 层级三: canUseTool 兜底 (含 Bash cat 图片拦截)
      canUseTool: guard.canUseTool,

      // AbortController
      ...(abortController ? { abortController } : {}),

      // [RESUME] 核心改动：如果已有 SDK session_id，用 resume 续接对话
      // SDK 会自动从 ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl 恢复完整上下文
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    }
  }

  /**
   * 发送消息给Claude并获取响应（非流式，支持 resume）
   *
   * [RESUME 改造]:
   *   - 新增 sessionId 参数：业务层会话 ID
   *   - prompt 只传当前用户消息（不再拼接历史）
   *   - 从 result 中捕获 SDK session_id 并持久化
   */
  async sendMessage(
    userMessage: string,
    systemPrompt?: string,
    sessionId?: string,
  ): Promise<AgentResponse> {
    try {
      const toolsConfig = await this.toolManager.getTools()

      // [RESUME] 使用异步生成器作为提示 (含 VisionGuard 三层防线 + resume)
      const response = query({
        prompt: userMessage,
        options: this.buildQueryOptions(toolsConfig, systemPrompt, undefined, sessionId),
      })

      let result = ''
      let lastAssistantContent = ''

      // 处理AI响应流
      for await (const message of response) {
        if (message.type === 'result') {
          // [RESUME] 捕获 SDK 分配的 session_id，持久化以便下次 resume
          if (sessionId && message.session_id) {
            this.sessionIdStore.set(sessionId, message.session_id)
          }
          result += (message as any).result
        } else if (message.type === 'assistant') {
          const assistantContent = message?.message?.content
          if (assistantContent) {
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
   * 流式发送消息给Claude（支持 resume）
   *
   * [RESUME 改造]:
   *   - 新增 sessionId 参数：业务层会话 ID，用于 resume 续接
   *   - prompt 只传当前用户消息（SDK 通过 resume 自动恢复完整上下文）
   *   - 从 result 中捕获 SDK session_id 并持久化
   *
   * 消息处理逻辑与原版完全相同，仅改变了"上下文来源"：
   *   原来: 手动拼接历史 → 每次全新 session
   *   现在: SDK resume → 自动恢复完整 session（包括工具调用历史）
   */
  async sendMessageStream(
    userMessage: string,
    eventHandlers?: EventHandlers,
    systemPrompt?: string,
    abortController?: AbortController,
    sessionId?: string,
  ): Promise<string> {
    let result = ''
    let pushedContent = ''
    let allThinkingContent = ''
    let lastThinkingContent = ''
    const toolUseIdToName = new Map<string, string>()
    const toolUseIdToParent = new Map<string, string>()

    try {
      await eventHandlers?.onContentStart?.()
      const toolsConfig = await this.toolManager.getTools()

      // [RESUME] prompt 只传当前用户消息，不再拼接历史
      // SDK 通过 resume 选项自动恢复之前的完整对话上下文
      console.log({
        prompt: userMessage,
        options: this.buildQueryOptions(toolsConfig, systemPrompt, undefined, sessionId),
      })
      const response = query({
        prompt: userMessage,
        options: this.buildQueryOptions(toolsConfig, systemPrompt, abortController, sessionId),
      })

      // 处理AI响应流（abortController.abort() 会中断此循环）
      for await (const message of response) {
        if (message.type === 'result') {
          // ====== result 消息：最终结果 ======
          const resultMsg = message as any
          const messageResult = resultMsg.result

          // [RESUME] 捕获 SDK session_id 并持久化
          if (sessionId && message.session_id) {
            this.sessionIdStore.set(sessionId, message.session_id)
          }

          if (messageResult && messageResult.trim()) {
            result = messageResult

            if (pushedContent && messageResult.startsWith(pushedContent)) {
              const delta = messageResult.slice(pushedContent.length)
              if (delta.trim()) {
                await eventHandlers?.onContentDelta?.(delta)
                pushedContent += delta
              }
            } else if (!pushedContent) {
              await eventHandlers?.onContentDelta?.(messageResult)
              pushedContent = messageResult
            } else if (messageResult.length > pushedContent.length && messageResult !== pushedContent) {
              const delta = '\n\n' + messageResult
              await eventHandlers?.onContentDelta?.(delta)
              pushedContent += delta
            }
          }

        } else if (message.type === 'assistant') {
          // ====== assistant 消息：包含 thinking / text / tool_use 块 ======
          const parentToolUseId: string | null = (message as any).parent_tool_use_id ?? null
          const isSubAgentMessage = parentToolUseId != null

          const msg = message?.message
          const assistantContent = msg?.content

          if (assistantContent && Array.isArray(assistantContent)) {
            let hasThinkingInThisMessage = false

            for (const block of assistantContent) {
              // --- thinking 块 ---
              if (block.type === 'thinking' && block.thinking) {
                if (!isSubAgentMessage) {
                  hasThinkingInThisMessage = true
                  allThinkingContent += block.thinking
                  lastThinkingContent = block.thinking
                  await eventHandlers?.onThinkingDelta?.(block.thinking)
                }
              }

              // --- tool_use 块 ---
              if (block.type === 'tool_use') {
                if (block.id && block.name) {
                  toolUseIdToName.set(block.id, block.name)
                  if (parentToolUseId) {
                    toolUseIdToParent.set(block.id, parentToolUseId)
                  }
                }
                await eventHandlers?.onToolUseStart?.(block.name, block.input, parentToolUseId, block.id)
              }

              // --- text 块 ---
              if (block.type === 'text' && block.text) {
                if (!isSubAgentMessage) {
                  await eventHandlers?.onContentDelta?.(block.text)
                  pushedContent += block.text
                }
              }
            }
            if (hasThinkingInThisMessage) {
              await eventHandlers?.onThinkingStop?.()
            }
          }

        } else if (message.type === 'user') {
          // ====== user 消息：工具执行结果 ======
          const userParentToolUseId: string | null = (message as any).parent_tool_use_id ?? null
          const userMsg = message as any

          const messageContent = userMsg.message?.content
          if (Array.isArray(messageContent)) {
            for (const entry of messageContent) {
              if (entry?.type === 'tool_result' && entry?.tool_use_id) {
                const toolUseId = entry.tool_use_id
                const toolName = toolUseIdToName.get(toolUseId) || 'unknown_tool'
                const effectiveParent = toolUseIdToParent.get(toolUseId) ?? userParentToolUseId

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

                await eventHandlers?.onToolUseStop?.(toolName, resultContent, effectiveParent, toolUseId)
              }
            }
          } else {
            // [FALLBACK] 旧路径
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

              const effectiveParent = toolUseIdToParent.get(parentToolUseId) ?? userParentToolUseId
              await eventHandlers?.onToolUseStop?.(toolName, resultContent, effectiveParent, parentToolUseId)
            }
          }
        }
        // 其他消息类型暂不处理
      }

      // 终极兜底
      if (!result.trim() && !pushedContent.trim() && lastThinkingContent.trim()) {
        result = lastThinkingContent
        await eventHandlers?.onContentDelta?.(lastThinkingContent)
      }

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
   * 压缩查询内容（兼容旧接口，不使用 resume）
   * 注意：这是辅助性的 LLM 调用，不应该参与主对话的 session 管理
   */
  async compressQuery(params: { systemPrompt: string; prompt: string; maxTokens: number }): Promise<string> {
    const result = await this.sendMessage(
      params.prompt,
      params.systemPrompt,
      // 不传 sessionId → 不走 resume，独立一次性调用
    )
    return result.content || ''
  }

  /**
   * 执行原始Claude查询（兼容旧接口，不使用 resume）
   */
  async executeClaudeQueryRaw(systemPrompt: string, prompt: string): Promise<any> {
    return this.sendMessage(prompt, systemPrompt)
  }
}
