/**
 * Memory Tools - Claude 工具定义 + 执行器
 * V5.3 - save 新增 keywords 字段，LLM 保存时生成同义词索引
 */

import z from 'zod'
import { MemoryDB } from '../../memory/memory-db.js'
import type { RegisteredTool, ToolExecutionResult } from '../types/tools.js'

// ==================== 工具 Schema ====================

const saveMemorySchema = {
  text: z.string().min(1, '记忆内容不能为空').describe(
    '记忆内容（自然语言，保持简洁，一句话概括核心信息）'
  ),
  keywords: z.string().optional().default('').describe(
    '搜索索引关键词（空格分隔）。为这条记忆生成 5-15 个同义词、别名、相关术语，覆盖用户可能的不同问法。' +
    '例如记忆"不要使用emoji"→ keywords 填"表情 表情符号 颜文字 emoticon smiley 图标 icon 小表情 表情包"。' +
    '例如记忆"项目用 TypeScript"→ keywords 填"TS 语言 编程语言 前端 后端 类型系统 技术栈 tech stack"。' +
    '注意：只填关键词，不要写句子。覆盖中英文、缩写、口语化表达。'
  ),
  cat: z.enum(['preference', 'decision', 'context', 'correction', 'instruction', 'knowledge']).describe('记忆分类'),
  imp: z.number().min(1).max(5).describe('重要性 1-5'),
  source: z.enum(['USER', 'PROJECT', 'GLOBAL']).optional().default('USER').describe('来源'),
}

const searchMemorySchema = {
  query: z.string().min(1, '搜索关键词不能为空').describe('搜索关键词'),
  cat: z.enum(['preference', 'decision', 'context', 'correction', 'instruction', 'knowledge']).optional().describe('按分类筛选'),
  limit: z.number().min(1).max(50).optional().default(10).describe('返回条数'),
}

const deleteMemorySchema = {
  query: z.string().min(1, '删除关键词不能为空').describe('要删除的记忆关键词'),
  exact_match: z.boolean().optional().default(false).describe('是否精确匹配'),
  dry_run: z.boolean().optional().default(true).describe('预览模式（不实际删除）'),
}

// ==================== 创建工具实例 ====================

/**
 * 创建记忆工具集（需要传入 MemoryDB 实例）
 */
export function createMemoryTools(memoryDb: MemoryDB): RegisteredTool[] {
  const saveMemoryTool: RegisteredTool = {
    name: 'save_memory',
    description:
      '保存一条记忆。发现用户偏好、重要决定、纠正、指令等信息时主动调用。' +
      '务必同时填写 keywords 字段，生成 5-15 个同义词/别名/相关术语作为搜索索引，覆盖用户未来可能的不同问法。',
    inputSchema: saveMemorySchema,
    execute: async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        const text = args.text as string
        const keywords = (args.keywords as string) || ''
        const cat = args.cat as string
        const imp = args.imp as number
        const source = (args.source as string) || 'USER'

        const result = memoryDb.insert({
          text,
          keywords,
          cat: cat as 'preference' | 'decision' | 'context' | 'correction' | 'instruction' | 'knowledge',
          imp,
          source: source as 'USER' | 'PROJECT' | 'GLOBAL',
        })

        // 每次写入后触发淘汰检查
        memoryDb.compact()

        const kwPreview = keywords ? ` [kw: ${keywords.slice(0, 40)}${keywords.length > 40 ? '...' : ''}]` : ''
        return {
          success: true,
          output: `Memory ${result}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"${kwPreview}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `保存记忆失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  const searchMemoryTool: RegisteredTool = {
    name: 'search_memory',
    description: `搜索已保存的记忆。注意：system prompt 中 Active Memories 已包含所有imp≥4 的高优记忆，如果答案已在其中则无需调用此工具。仅当需要查找 Active Memories 中没有的低优先级记忆时才调用。`,
    inputSchema: searchMemorySchema,
    execute: async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        const query = args.query as string
        const cat = args.cat as string | undefined
        const limit = (args.limit as number) || 10

        let results = memoryDb.search(query, limit)
        if (cat) {
          results = results.filter(r => r.cat === cat)
        }

        if (results.length === 0) {
          return {
            success: true,
            output: 'No matching memories found.',
          }
        }

        const formatted = results
          .map(r => `[${r.cat}](imp=${r.imp}) ${r.text}`)
          .join('\n')

        return {
          success: true,
          output: formatted,
        }
      } catch (error) {
        return {
          success: false,
          error: `搜索记忆失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  const deleteMemoryTool: RegisteredTool = {
    name: 'delete_memory',
    description: '删除记忆。用户明确要求忘记某些信息时调用。建议先 dry_run 预览。',
    inputSchema: deleteMemorySchema,
    execute: async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      try {
        const query = args.query as string
        const exact_match = (args.exact_match as boolean) || false
        const dry_run = args.dry_run !== false // 默认 true

        const { count, entries } = memoryDb.delete(query, { exact_match, dry_run })

        if (dry_run) {
          const preview = entries
            .map(e => `- ${e.text}`)
            .join('\n')
          return {
            success: true,
            output: `[DRY RUN] Would delete ${count} entries:\n${preview || '(none)'}`,
          }
        }

        return {
          success: true,
          output: `Deleted ${count} memory entries.`,
        }
      } catch (error) {
        return {
          success: false,
          error: `删除记忆失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  return [saveMemoryTool, searchMemoryTool, deleteMemoryTool]
}
