/**
 * Link Analyze Tool - 链接内容抓取与分析
 *
 * 功能：给定 URL，自动抓取页面内容并转换为结构化 Markdown
 * 对标：Mira 平台 web_builtin_fetch 的实现逻辑
 *
 * 核心流程：
 *   1. HTTP GET（Node.js 内置 http/https，零外部依赖）
 *   2. 自动跟随重定向（支持 301/302/303/307/308）
 *   3. HTML 预清洗（去 script/style/nav/popup 等噪音）
 *   4. Readability 正文提取（Mozilla Firefox 阅读模式算法）
 *   5. HTML → Markdown 转换（Turndown）
 *   6. 元数据提取（title/description/images/links）
 */
import z from 'zod'
import * as http from 'node:http'
import * as https from 'node:https'
import { JSDOM } from 'jsdom'
import type { RegisteredTool } from '../types/tools.js'
import { Readability } from '@mozilla/readability'

// ============================================================
// 配置
// ============================================================
const DEFAULT_TIMEOUT = 30_000
const MAX_REDIRECTS = 10
const DEFAULT_MAX_LENGTH = 50_000
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ============================================================
// 1. HTTP 请求层 —— 纯 Node.js 内置模块
// ============================================================

interface HttpResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: string
  finalUrl: string
  redirectChain: string[]
}

/**
 * HTTP GET 请求，自动跟随重定向
 */
function httpGet(url: string, timeout = DEFAULT_TIMEOUT): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const redirectChain: string[] = [url]
    let currentUrl = url
    let redirectCount = 0

    function doRequest() {
      const parsedUrl = new URL(currentUrl)
      const mod = parsedUrl.protocol === 'https:' ? https : http

      const req = mod.get(
        currentUrl,
        {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
          },
          timeout,
        },
        (res) => {
          // 处理重定向
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location
            if (!location) {
              reject(new Error('Redirect without Location header'))
              return
            }
            if (++redirectCount > MAX_REDIRECTS) {
              reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`))
              return
            }
            currentUrl = new URL(location, currentUrl).href
            redirectChain.push(currentUrl)
            res.resume()
            doRequest()
            return
          }

          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString('utf-8'),
              finalUrl: currentUrl,
              redirectChain,
            })
          })
          res.on('error', reject)
        },
      )

      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Request timeout after ${timeout}ms`))
      })
      req.on('error', reject)
    }

    doRequest()
  })
}

// ============================================================
// 2. HTML 清洗 —— 去掉脚本/样式/导航等噪音
// ============================================================

/** 需要移除的标签 */
const REMOVE_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'canvas', 'video', 'audio', 'source',
]

/** 需要移除的噪音 CSS 选择器 */
const NOISE_SELECTORS = [
  'nav', 'footer', '[role="navigation"]', '[role="complementary"]',
  '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
  '[class*="login-mask"]', '[class*="cookie-"]', '[class*="sidebar"]',
  '[class*="ad-"]', '[class*="advertisement"]',
  '[style*="display:none"]', '[style*="display: none"]', '[hidden]',
]

/**
 * 微信公众号等平台会把正文设为 visibility:hidden / opacity:0，
 * 靠前端 JS 加载完成后再显示。纯 HTTP 抓取拿到的 HTML 中正文虽然存在，
 * 但被这些 CSS 属性隐藏了，导致 Readability 提取时被忽略。
 *
 * 此函数在 DOM 清洗阶段把这些「假隐藏」样式移除，让正文重新可见。
 */
function unhideContent(doc: Document): void {
  // 1. 微信公众号：#js_content { visibility: hidden; opacity: 0 }
  const jsContent = doc.getElementById('js_content')
  if (jsContent) {
    jsContent.removeAttribute('style')
  }

  // 2. 通用：移除所有 visibility:hidden 和 opacity:0 的 inline style
  //    但只处理可能包含正文的容器（article, section, div），避免误伤
  const candidates = doc.querySelectorAll('article, section, div, main')
  candidates.forEach((el) => {
    const style = el.getAttribute('style') || ''
    if (
      style.includes('visibility') ||
      style.includes('opacity: 0') ||
      style.includes('opacity:0')
    ) {
      // 只移除隐藏相关的样式，保留其他样式
      const cleaned = style
        .replace(/visibility\s*:\s*hidden\s*;?/gi, '')
        .replace(/opacity\s*:\s*0\s*;?/gi, '')
        .trim()
      if (cleaned) {
        el.setAttribute('style', cleaned)
      } else {
        el.removeAttribute('style')
      }
    }
  })
}

function cleanHtml(html: string): string {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  // ★ 先解除隐藏内容（必须在移除噪音之前）
  unhideContent(doc)

  // 移除无用标签
  for (const tag of REMOVE_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove())
  }

  // 移除噪音元素
  for (const sel of NOISE_SELECTORS) {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.remove())
    } catch {
      // 选择器不支持则跳过
    }
  }

  return doc.documentElement.outerHTML
}

// ============================================================
// 3. 正文提取 —— Mozilla Readability
// ============================================================

interface ExtractedArticle {
  title: string
  content: string      // HTML 格式的正文
  textContent: string  // 纯文本
  excerpt: string
  byline: string
  siteName: string
}

async function extractArticle(html: string, url: string): Promise<ExtractedArticle | null> {
  const dom = new JSDOM(html, { url })
  const reader = new Readability(dom.window.document, {
    charThreshold: 50,
  })

  const article = reader.parse()
  if (!article) return null

  return {
    title: article.title || '',
    content: article.content || '',
    textContent: article.textContent || '',
    excerpt: article.excerpt || '',
    byline: article.byline || '',
    siteName: article.siteName || '',
  }
}

// ============================================================
// 4. HTML → Markdown 转换 —— Turndown
// ============================================================

async function htmlToMarkdown(html: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: TurndownService } = await import("turndown") as any
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  })

  // 移除空链接
  turndown.addRule('emptyLinks', {
    filter: (node: any) => node.nodeName === 'A' && !node.textContent?.trim(),
    replacement: () => '',
  })

  let markdown = turndown.turndown(html)

  // 清理多余空行
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
  return markdown
}

// ============================================================
// 5. 元数据提取
// ============================================================

interface PageMeta {
  title: string
  description: string
  ogImage: string
  author: string
  keywords: string
}

function extractMeta(html: string): PageMeta {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  const getMeta = (name: string): string => {
    const el =
      doc.querySelector(`meta[name="${name}"]`) ||
      doc.querySelector(`meta[property="${name}"]`) ||
      doc.querySelector(`meta[property="og:${name}"]`)
    return el?.getAttribute('content') || ''
  }

  return {
    title: doc.querySelector('title')?.textContent?.trim() || getMeta('title'),
    description: getMeta('description') || getMeta('og:description'),
    ogImage: getMeta('og:image') || getMeta('image'),
    author: getMeta('author') || getMeta('article:author'),
    keywords: getMeta('keywords'),
  }
}

// ============================================================
// 6. 主函数 —— 串联管道
// ============================================================

interface AnalyzeResult {
  url: string
  finalUrl: string
  redirected: boolean
  statusCode: number
  meta: PageMeta
  markdown: string
  textLength: number
  method: 'readability' | 'fallback'
}

async function analyzeLink(url: string, maxLength: number): Promise<AnalyzeResult> {
  // Step 1: HTTP 请求
  const response = await httpGet(url)
  const contentType = String(response.headers['content-type'] || '')

  // 非 HTML：直接返回原文
  if (!contentType.includes('html')) {
    const body = response.body.slice(0, maxLength)
    return {
      url,
      finalUrl: response.finalUrl,
      redirected: response.redirectChain.length > 1,
      statusCode: response.statusCode,
      meta: { title: '', description: '', ogImage: '', author: '', keywords: '' },
      markdown: body,
      textLength: body.length,
      method: 'fallback',
    }
  }

  // Step 2: 提取元数据（从原始 HTML）
  const meta = extractMeta(response.body)

  // Step 3: 清洗 HTML（包含 unhideContent 解除隐藏）
  const cleaned = cleanHtml(response.body)

  // Step 4: Readability 正文提取
  let markdown = ''
  let method: 'readability' | 'fallback' = 'fallback'

  const article = await extractArticle(cleaned, response.finalUrl)
  if (article && article.textContent.length > 100) {
    // Readability 成功
    markdown = await htmlToMarkdown(article.content)
    if (article.title && !meta.title) {
      meta.title = article.title
    }
    if (article.byline && !meta.author) {
      meta.author = article.byline
    }
    method = 'readability'
  } else {
    // 降级：直接转换清洗后的 HTML
    markdown = await htmlToMarkdown(cleaned)
    method = 'fallback'
  }

  // Step 5: 截断
  if (markdown.length > maxLength) {
    markdown = markdown.slice(0, maxLength) + '\n\n...[内容过长，已截断]'
  }

  return {
    url,
    finalUrl: response.finalUrl,
    redirected: response.redirectChain.length > 1,
    statusCode: response.statusCode,
    meta,
    markdown,
    textLength: markdown.length,
    method,
  }
}

// ============================================================
// 7. 格式化输出
// ============================================================

function formatOutput(result: AnalyzeResult): string {
  const parts: string[] = []

  // 基础信息
  parts.push(`## 页面信息`)

  const infoRows = [
    `| 项目 | 内容 |`,
    `|------|------|`,
    `| **最终URL** | ${result.finalUrl} |`,
    `| **状态码** | ${result.statusCode} |`,
  ]
  if (result.redirected) {
    infoRows.push(`| **重定向** | ${result.url} → ${result.finalUrl} |`)
  }
  if (result.meta.title) {
    infoRows.push(`| **标题** | ${result.meta.title} |`)
  }
  if (result.meta.author) {
    infoRows.push(`| **作者** | ${result.meta.author} |`)
  }
  if (result.meta.description) {
    infoRows.push(`| **描述** | ${result.meta.description} |`)
  }
  if (result.meta.keywords) {
    infoRows.push(`| **关键词** | ${result.meta.keywords} |`)
  }
  infoRows.push(`| **内容长度** | ${result.textLength} 字符 |`)
  infoRows.push(`| **提取方式** | ${result.method} |`)

  parts.push(infoRows.join('\n'))

  // 正文
  parts.push(`## 页面正文\n\n${result.markdown}`)

  return parts.join('\n\n')
}

// ============================================================
// 8. 工具导出 —— 符合 my_claw RegisteredTool 规范
// ============================================================

const linkAnalyzeSchema = {
  url: z.string().url('请输入有效的URL').describe('要分析的网页链接（支持短链接，会自动跟随重定向）'),
  max_length: z
    .number()
    .min(500)
    .max(100_000)
    .optional()
    .default(DEFAULT_MAX_LENGTH)
    .describe('最大输出字符数（默认 50000）'),
}

export const linkAnalyzeTool: RegisteredTool = {
  name: 'link_analyze',
  description: [
    '网页链接内容抓取与分析工具。',
    '输入任意URL（支持短链接/重定向），自动抓取页面内容并转换为结构化Markdown。',
    '适用于：分析文章内容、提取笔记正文（小红书/微信公众号等）、',
    '阅读新闻报道、查看文档页面。',
    '零浏览器依赖，纯HTTP请求实现，速度快、成功率高。',
  ].join(''),
  inputSchema: linkAnalyzeSchema,
  execute: async (args: Record<string, unknown>) => {
    const url = args.url as string
    const maxLength = (args.max_length as number) || DEFAULT_MAX_LENGTH

    try {
      console.log(`🔗 link_analyze: ${url}`)
      const startTime = Date.now()

      const result = await analyzeLink(url, maxLength)

      const elapsed = Date.now() - startTime
      console.log(`✅ link_analyze 完成: ${elapsed}ms, ${result.textLength} chars, method=${result.method}`)

      return {
        success: true,
        output: formatOutput(result),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      console.error(`❌ link_analyze 失败: ${message}`)
      return {
        success: false,
        error: `链接分析失败: ${message}`,
      }
    }
  },
}

/**
 * 工厂函数（与项目中 createXxxTools 风格一致）
 */
export function createLinkAnalyzeTools(): RegisteredTool[] {
  console.log('✅ Link Analyze 工具已注册 (link_analyze)')
  return [linkAnalyzeTool]
}
