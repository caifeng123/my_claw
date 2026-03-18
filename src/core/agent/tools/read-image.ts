/**
 * read_image MCP Tool
 * 
 * 自定义图片读取工具，读取本地图片文件并返回 base64 格式供 Agent 视觉分析。
 * 
 * 注意：此工具直接返回 MCP image content（非 RegisteredTool 格式），
 * 因此以独立 MCP Server 形式注册，不经过 ToolManager 的文本包装管线。
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync } from 'fs'

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

const readImageTool = tool(
  'read_image',
  'Read a local image file and return it as base64 for visual analysis. Use this tool when you need to view or analyze image content.',
  { file_path: z.string().describe('Path to the image file (absolute or relative to cwd)') },
  async (args) => {
    const { file_path } = args

    if (!existsSync(file_path)) {
      return { content: [{ type: 'text' as const, text: `File not found: ${file_path}` }] }
    }

    const ext = file_path.split('.').pop()?.toLowerCase() || ''
    const mimeType = IMAGE_MEDIA_TYPES[ext] || 'image/png'
    const data = readFileSync(file_path).toString('base64')

    return {
      content: [
        {
          type: 'image' as const,
          data,
          mimeType,
        },
      ],
    }
  }
)

export const IMAGE_SERVER_NAME = 'image-reader'

export const imageReaderServer = createSdkMcpServer({
  name: IMAGE_SERVER_NAME,
  version: '1.0.0',
  tools: [readImageTool],
})

/** allowedTools 条目，供 ToolManager 合并 */
export const IMAGE_TOOL_ALLOWED = `mcp__${IMAGE_SERVER_NAME}__read_image`
