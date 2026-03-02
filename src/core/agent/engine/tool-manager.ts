import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type {
  RegisteredTool,
  ToolExecutionContext,
  ToolCallRequest,
  ToolCallResponse,
  ToolValidationResult,
} from '../types/tools'
import { calculatorTool, timeTool } from '../tools/calculator';

export const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit'
];

const CUSTOM_TOOLS = [
  calculatorTool, timeTool
]

export class ToolManager {
  private tools: Map<string, RegisteredTool>
  private rateLimitBuckets: Map<string, { count: number; resetTime: number }>
  private toolPrefix = "cf-claw-tools"

  constructor() {
    this.tools = new Map()
    this.rateLimitBuckets = new Map()
  }

  /**
   * 注册新工具
   */
  registerTool(options: RegisteredTool): void {
    if (this.tools.has(options.name)) {
      return
    }

    const tool: RegisteredTool = {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema,
      execute: options.execute,
    }

    this.tools.set(options.name, tool)
    console.log(`✅ 工具注册成功: ${options.name}`)
  }

  /**
   * 获取MCP工具配置（参考官方写法）
   */
  async getTools() {
    CUSTOM_TOOLS.forEach(tool => this.registerTool(tool))
    // 1. 注册内部工具
    const internalTools = Array.from(this.tools.values()).map((handler) => {
      return tool(
        handler.name,
        handler.description,
        handler.inputSchema,
        async (args) => {
          try {
            const result = await handler.execute(args)
            console.log(`✅ 工具执行成功: ${handler.name}`)
            return {
              content: [{
                type: "text",
                text: typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2)
              }]
            }
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `执行工具时出错: ${error instanceof Error ? error.message : '未知错误'}`
              }]
            }
          }
        }
      )
    })

    // 2. 注册外部 MCP 工具（暂时为空，可根据需要扩展）
    const externalMcpTools: any[] = []

    // 3. 合并所有工具
    const allTools = [...internalTools, ...externalMcpTools]

    const allowedTools = allTools.map((t) => `mcp__${this.toolPrefix}__${t.name}`)

    return {
      mcpServers: {
        [this.toolPrefix]: createSdkMcpServer({
          name: this.toolPrefix,
          version: "1.0.0",
          tools: allTools,
        }),
      },
      allowedTools: [...allowedTools, ...DEFAULT_ALLOWED_TOOLS],
    }
  }

  /**
   * 获取所有已注册的工具名称（用于Claude Agent SDK的allowedTools）
   */
  getClaudeTools(): string[] {
    return Array.from(this.tools.values()).map(tool => tool.name)
  }

  /**
   * 执行工具调用
   */
  async executeTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    const startTime = Date.now()
    const tool = this.tools.get(request.toolName)

    if (!tool) {
      return {
        toolName: request.toolName,
        success: false,
        error: `工具未找到: ${request.toolName}`,
        executionTime: Date.now() - startTime,
      }
    }

    // 验证输入参数
    const validation = this.validateInput(tool, request.parameters)
    if (!validation.isValid) {
      return {
        toolName: request.toolName,
        success: false,
        error: `参数验证失败: ${validation.errors.map(e => e.message).join(', ')}`,
        executionTime: Date.now() - startTime,
      }
    }

    try {
      // 执行工具
      const context: ToolExecutionContext = {
        sessionId: request.sessionId,
        userId: request.userId,
        parameters: request.parameters,
      }

      const result = await tool.execute(context)

      return {
        toolName: request.toolName,
        success: result.success,
        output: result.output,
        error: result.error,
        executionTime: Date.now() - startTime,
      }
    } catch (error) {
      console.error(`工具执行错误: ${request.toolName}`, error)

      return {
        toolName: request.toolName,
        success: false,
        error: `工具执行异常: ${error instanceof Error ? error.message : '未知错误'}`,
        executionTime: Date.now() - startTime,
      }
    }
  }

  /**
   * 验证输入参数
   */
  private validateInput(tool: RegisteredTool, parameters: Record<string, any>): ToolValidationResult {
    const errors: { field: string; message: string }[] = []

    // 检查参数类型（简单验证）
    for (const [key, value] of Object.entries(parameters)) {
      if (!tool.inputSchema[key]) continue
      try {
        tool.inputSchema[key]?.parse(value)
      } catch (error) {
        errors.push({
          field: key,
          message: error instanceof Error ? error.message : '参数类型错误',
        })
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    }
  }

  /**
   * 获取所有工具名称
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 检查工具是否存在
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName)
  }

  /**
   * 清空所有工具
   */
  clearTools(): void {
    this.tools.clear()
    this.rateLimitBuckets.clear()
  }
}