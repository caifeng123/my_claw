import z from 'zod'
import type { RegisteredTool } from '../types/tools'

/**
 * 计算器工具示例
 */
export const calculatorTool: RegisteredTool = {
  name: 'calculator',
  description: '一个计算超能算子的工具',
  inputSchema: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  execute: async (args) => {
    try {
      const { a, b } = args

      return {
        success: true,
        output: `${a} + ${b} = ${a + b}`
      }
    } catch (error) {
      return {
        success: false,
        error: `超能算子计算: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }
  }
}

/**
 * 时间工具示例
 */
export const timeTool: RegisteredTool = {
  name: 'get_current_time',
  description: '获取当前时间',
  inputSchema: {
    format: z.enum(['iso', 'locale', 'timestamp']).describe("Time format").default('iso')
  },
  execute: async (args) => {
    try {
      const { format = 'iso' } = args
      const now = new Date()

      let result: string

      switch (format) {
        case 'iso':
          result = now.toISOString()
          break
        case 'locale':
          result = now.toLocaleString()
          break
        case 'timestamp':
          result = now.getTime().toString()
          break
        default:
          result = now.toISOString()
      }

      return {
        success: true,
        output: `当前时间 (${format}): ${result}`
      }
    } catch (error) {
      return {
        success: false,
        error: `时间工具执行错误: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }
  }
}