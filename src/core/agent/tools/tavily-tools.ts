/**
 * Tavily Tools - AI-optimized web search & content extraction
 * 通过 Tavily REST API 提供搜索和网页内容提取能力
 */
import z from 'zod'
import type { RegisteredTool } from '../types/tools.js'

const TAVILY_BASE_URL = 'https://api.tavily.com'

// ==================== 工具 Schema ====================

const tavilySearchSchema = {
  query: z.string().min(1, '搜索关键词不能为空').describe('搜索查询语句'),
  search_depth: z.enum(['basic', 'advanced', 'fast', 'ultra-fast']).optional()
    .default('basic').describe('搜索深度: basic(平衡) / advanced(高精度,2 credits) / fast(快速) / ultra-fast(极速)'),
  topic: z.enum(['general', 'news', 'finance']).optional()
    .default('general').describe('搜索类别: general(通用) / news(新闻) / finance(财经)'),
  max_results: z.number().min(1).max(20).optional()
    .default(5).describe('最大返回结果数 (1-20)'),
  time_range: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('时间范围过滤'),
  include_answer: z.boolean().optional()
    .default(true).describe('是否返回AI生成的答案摘要'),
  include_raw_content: z.boolean().optional()
    .default(false).describe('是否返回网页原始内容(markdown)'),
  include_domains: z.array(z.string()).optional()
    .describe('限定搜索的域名列表'),
  exclude_domains: z.array(z.string()).optional()
    .describe('排除的域名列表'),
}

const tavilyExtractSchema = {
  urls: z.array(z.string().url()).min(1).max(20)
    .describe('要提取内容的URL列表(最多20个)'),
}

// ==================== API 调用层 ====================

async function tavilyRequest(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''

  const response = await fetch(`${TAVILY_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY_API_KEY, ...body }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Tavily API ${response.status}: ${errorText || response.statusText}`)
  }

  return response.json()
}

// ==================== 结果格式化 ====================

function formatSearchResults(data: any): string {
  const parts: string[] = []

  // AI 摘要
  if (data.answer) {
    parts.push(`## AI Answer\n${data.answer}`)
  }

  // 搜索结果
  const results = data.results || []
  if (results.length > 0) {
    parts.push(`## Results (${results.length})`)
    for (const r of results) {
      let entry = `### ${r.title}\n- **URL**: ${r.url}\n- **Score**: ${r.score?.toFixed(4)}`
      if (r.content) {
        entry += `\n- **Content**: ${r.content}`
      }
      if (r.raw_content) {
        // 截断过长的原始内容
        const raw = r.raw_content.length > 3000
          ? r.raw_content.slice(0, 3000) + '\n...(truncated)'
          : r.raw_content
        entry += `\n- **Raw Content**:\n${raw}`
      }
      parts.push(entry)
    }
  } else {
    parts.push('No results found.')
  }

  return parts.join('\n\n')
}

function formatExtractResults(data: any): string {
  const parts: string[] = []
  const results = data.results || []
  const failed = data.failed_results || []

  if (results.length > 0) {
    parts.push(`## Extracted (${results.length})`)
    for (const r of results) {
      const content = r.raw_content?.length > 5000
        ? r.raw_content.slice(0, 5000) + '\n...(truncated)'
        : r.raw_content || 'No content extracted'
      parts.push(`### ${r.url}\n${content}`)
    }
  }

  if (failed.length > 0) {
    parts.push(`## Failed (${failed.length})`)
    for (const f of failed) {
      parts.push(`- ${f.url}: ${f.error || 'unknown error'}`)
    }
  }

  return parts.join('\n\n')
}

// ==================== 导出工具 ====================

export function createTavilyTools(): RegisteredTool[] {
  const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''
  if (!TAVILY_API_KEY) {
    console.warn('⚠️ TAVILY_API_KEY 未设置，Tavily 工具已禁用')
    return []
  }

  const searchTool: RegisteredTool = {
    name: 'tavily_search',
    description: [
      'AI优化的网页搜索引擎，专为LLM Agent设计。',
      '比普通搜索更精准，返回结构化结果和AI摘要。',
      '支持: 新闻搜索(topic=news)、财经搜索(topic=finance)、',
      '时间过滤(time_range)、域名过滤(include/exclude_domains)、',
      '高精度搜索(search_depth=advanced)。',
    ].join(''),
    inputSchema: tavilySearchSchema,
    execute: async (args: Record<string, unknown>) => {
      try {
        // 构建请求参数，移除 undefined 值
        const params: Record<string, unknown> = { query: args.query }
        if (args.search_depth) params.search_depth = args.search_depth
        if (args.topic) params.topic = args.topic
        if (args.max_results) params.max_results = args.max_results
        if (args.time_range) params.time_range = args.time_range
        if (args.include_answer !== undefined) params.include_answer = args.include_answer
        if (args.include_raw_content) params.include_raw_content = args.include_raw_content
        if (args.include_domains) params.include_domains = args.include_domains
        if (args.exclude_domains) params.exclude_domains = args.exclude_domains

        const data = await tavilyRequest('/search', params)
        return { success: true, output: formatSearchResults(data) }
      } catch (error) {
        return {
          success: false,
          error: `Tavily搜索失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  const extractTool: RegisteredTool = {
    name: 'tavily_extract',
    description: [
      '从指定URL批量提取网页主要内容。',
      '自动清洗HTML，返回结构化文本，最多同时提取20个URL。',
      '适用于: 深入阅读搜索结果、提取文章全文、批量抓取页面内容。',
    ].join(''),
    inputSchema: tavilyExtractSchema,
    execute: async (args: Record<string, unknown>) => {
      try {
        console.log('Tavily 提取工具参数:', args)
        const urls = args.urls as string[]
        const data = await tavilyRequest('/extract', { urls })
        return { success: true, output: formatExtractResults(data) }
      } catch (error) {
        return {
          success: false,
          error: `Tavily提取失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  console.log('✅ Tavily 工具已注册 (tavily_search, tavily_extract)')
  return [searchTool, extractTool]
}