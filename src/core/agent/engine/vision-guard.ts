/**
 * VisionGuard - 三层防线，确保图片文件走 Vision Sub-Agent 而非 Read tool
 *
 * 层级一: System Prompt 引导 (软约束)
 * 层级二: PreToolUse Hook 拦截 (硬约束)
 * 层级三: canUseTool 回调兜底 (终极保险)
 *
 * 核心思路: 图片 base64 永远不进入主 Coding Agent 上下文，
 * 由独立的 Vision Sub-Agent (haiku) 在隔离上下文中处理，
 * 只返回文字摘要 (~300-500 tokens) 给主 Agent。
 *
 * ⚠️ 关键: Hook 和 canUseTool 必须放行 Sub-Agent 内部的 Read 调用，
 *    否则会产生自拦截死锁。通过 HookInput.agent_id 区分：
 *    - agent_id 存在 → Sub-Agent 内部调用 → 放行
 *    - agent_id 不存在 → 主 Agent 调用 → 拦截
 *
 * V4.2: 新增图片分析缓存策略
 *   - 首次分析后缓存到 images.json（可覆盖）
 *   - context-builder 加载历史时将 ![image](path) 替换为 [图片: path] + [此前分析结果]
 *   - Claude 默认直接使用缓存结果，仅在判断不够用时主动重新分析
 */

import type {
  Options,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'

// ============================================================
// 常量
// ============================================================

/** 图片文件扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.svg', '.bmp', '.ico', '.tiff', '.tif',
  '.avif',
])

/**
 * 判断文件路径是否为图片文件
 */
function isImagePath(filePath: string): boolean {
  if (!filePath) return false
  const ext = filePath.toLowerCase().match(/\.\w+$/)?.[0]
  return ext ? IMAGE_EXTENSIONS.has(ext) : false
}

// ============================================================
// Vision Sub-Agent 定义
// ============================================================

/**
 * Vision Sub-Agent 配置
 * - 使用 haiku 模型 (便宜 + 快速, vision 能力足够)
 * - 只给 Read/Bash/Glob 工具 (最小权限)
 * - 独立上下文窗口, 图片 base64 不污染主 Agent
 */
const VISION_AGENT_DEFINITION = {
  description:
    'Image and screenshot analyzer. MUST be used for ANY image file ' +
    '(png/jpg/jpeg/gif/webp/svg/bmp/ico/tiff/avif) instead of Read tool. ' +
    'Reads and analyzes images in isolated context, returns concise text summaries. ' +
    'Use this whenever a task involves viewing, understanding, or extracting info from images.',

  prompt: `You are a vision analyst. Given an image file path:
1. Use the Read tool to load the image
2. Analyze its visual content
3. Return a structured summary

## Output Format

[IMAGE_SUMMARY]
Type: screenshot | error-log | architecture-diagram | UI-mockup | chart | code-screenshot | icon | data-table | other
Key Content: (exact text, error messages, code snippets, component structure, data values)
Actionable Details: (what a developer needs to debug/implement/fix/understand)

## Rules
- Max 500 tokens per image
- Preserve exact error messages, stack traces, file paths, and code VERBATIM
- For UI screenshots: describe component hierarchy, key text, interactive elements
- For architecture diagrams: describe nodes, edges, data flow directions
- For code screenshots: OCR the code content as accurately as possible
- For charts/graphs: extract data trends, key values, axis labels
- Focus on INFORMATION content, not visual aesthetics or colors
- If Read fails, use Bash to check: file <path>
- If the image is unreadable or corrupted, say so clearly`,

  tools: ['Read', 'Bash', 'Glob'] as string[],

  // 用最便宜的模型处理图片, 不浪费 Sonnet/Opus 额度
  model: 'haiku' as const,
}

// ============================================================
// 层级一: System Prompt 注入
// ============================================================

/** 要注入到主 Agent system prompt 中的图片处理规则 */
const IMAGE_HANDLING_RULES = `
## Image Handling Policy (MANDATORY)

You MUST follow these rules for ANY image file (${[...IMAGE_EXTENSIONS].join(', ')}):

1. **NEVER** read image files directly (Read tool is BLOCKED for images)
2. **ALWAYS** use the vision-analyzer subagent:
   Agent(subagent_type: "vision-analyzer", prompt: "Analyze the image at <file_path>")
3. Use ONLY the text summary returned by vision-analyzer for your reasoning
4. **Multiple images → analyze ALL at once**: When you need to analyze 2+ images, call Agent for each image in the SAME turn. Do NOT wait for one to finish before starting the next. Example:
   Agent(subagent_type: "vision-analyzer", prompt: "Analyze the image at /path/img1.png")
   Agent(subagent_type: "vision-analyzer", prompt: "Analyze the image at /path/img2.png")

## Cached Image Analysis

When conversation history contains "[图片: <path>]" followed by "[此前分析结果]: ...",
the image has already been analyzed. Rules:

**Use cache directly** (default): The cached result is sufficient for most follow-up questions.

**Re-analyze** only when:
- User explicitly says the previous analysis is wrong or asks to "look again"
- User asks about a completely different aspect not covered by the cached result
- The cached result is clearly incomplete or corrupted

To re-analyze, call vision-analyzer with the specific focus:
Agent(subagent_type: "vision-analyzer", prompt: "Re-analyze the image at <path>. Focus on: <specific question>")
`

// ============================================================
// 层级二: PreToolUse Hook - 拦截 Read tool 读图片
// ============================================================

/**
 * PreToolUse Hook: 当主 Agent 的 Read tool 尝试读取图片文件时, 拦截并引导使用 Sub-Agent
 *
 * ⚠️ 关键: 通过 agent_id 区分主 Agent vs Sub-Agent
 *   - agent_id 存在 → 这是 Sub-Agent 内部的调用 → 放行 (否则自拦截死锁)
 *   - agent_id 不存在 → 这是主 Agent 的调用 → 拦截
 */
const blockImageReadHook: HookCallback = async (
  input: HookInput,
  _toolUseId: string | undefined,
  _options: { signal: AbortSignal },
): Promise<HookJSONOutput> => {
  // 类型收窄: 只处理 PreToolUse 事件
  if (input.hook_event_name !== 'PreToolUse') return {}

  const preToolInput = input as PreToolUseHookInput

  // ✅ 放行 Sub-Agent 内部的调用 (agent_id 存在 = Sub-Agent 上下文)
  if (preToolInput.agent_id) return {}

  // 只拦截 Read tool
  if (preToolInput.tool_name !== 'Read') return {}

  // tool_input 类型为 unknown, 安全提取 file_path
  const toolInput = (preToolInput.tool_input ?? {}) as Record<string, unknown>
  const filePath = (toolInput.file_path as string)
    ?? (toolInput.path as string)
    ?? ''

  if (!isImagePath(filePath)) return {}

  // 拦截! 返回 block + 引导信息
  return {
    decision: 'block',
    reason:
      `⚠️ BLOCKED: Cannot read image file "${filePath}" directly with Read tool. ` +
      `Image files consume 10,000+ tokens of context as base64 data, degrading your reasoning ability. ` +
      `\n\nUse the vision-analyzer subagent instead:\n` +
      `Agent(subagent_type: "vision-analyzer", prompt: "Analyze the image at ${filePath}")`,
  }
}

// ============================================================
// 层级三: canUseTool 回调 - 兜底拦截 (含 Bash cat 图片)
// ============================================================

/**
 * canUseTool 回调: 拦截主 Agent 任何直接读取图片的尝试
 * - Read tool 读图片文件 → deny
 * - Bash 中 cat/base64/xxd 图片文件 → deny
 *
 * ⚠️ 注意: canUseTool 没有 agent_id 参数，无法区分主 Agent 和 Sub-Agent。
 *    但实际上 SDK 只对主 Agent 的工具调用触发 canUseTool，
 *    Sub-Agent 内部的工具调用走 Hook 通道而非 canUseTool。
 *    如果未来 SDK 行为变化，需要在此处也加 agent_id 判断。
 */
async function imageGuardCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  // 拦截 Read tool 读图片
  if (toolName === 'Read') {
    const filePath = (input.file_path as string) ?? (input.path as string) ?? ''
    if (isImagePath(filePath)) {
      return {
        behavior: 'deny',
        message:
          `Image file "${filePath}" blocked. ` +
          `Use vision-analyzer subagent: Agent(subagent_type: "vision-analyzer", prompt: "Analyze the image at ${filePath}")`,
      }
    }
  }

  // 拦截 Bash 中直接 cat/base64 图片
  if (toolName === 'Bash') {
    const cmd = (input.command as string) ?? ''
    const imageReadPattern = /\b(cat|base64|xxd|hexdump|od)\b[^|;]*\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)\b/i
    if (imageReadPattern.test(cmd)) {
      return {
        behavior: 'deny',
        message:
          `Reading image files via bash is blocked to protect context window. ` +
          `Use vision-analyzer subagent instead.`,
      }
    }
  }

  // 其他工具正常放行
  return { behavior: 'allow', updatedInput: input }
}

// ============================================================
// 导出: 集成到 ClaudeEngine 的配置生成器
// ============================================================

export interface VisionGuardConfig {
  /** Vision Sub-Agent 定义, 传入 options.agents */
  agents: Record<string, typeof VISION_AGENT_DEFINITION>
  /** 需要追加到 allowedTools 的工具名 */
  additionalAllowedTools: string[]
  /** PreToolUse Hook 配置, 传入 options.hooks */
  hooks: {
    PreToolUse: HookCallbackMatcher[]
  }
  /** canUseTool 回调, 传入 options.canUseTool */
  canUseTool: typeof imageGuardCanUseTool
  /** 需要追加到 system prompt 的图片处理规则 */
  systemPromptRules: string
}

/**
 * 获取 VisionGuard 完整配置
 */
export function getVisionGuardConfig(): VisionGuardConfig {
  return {
    agents: {
      'vision-analyzer': VISION_AGENT_DEFINITION,
    },
    additionalAllowedTools: ['Agent'],
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [blockImageReadHook],
        },
      ],
    },
    canUseTool: imageGuardCanUseTool,
    systemPromptRules: IMAGE_HANDLING_RULES,
  }
}

// 同时导出各组件, 方便单独使用
export {
  VISION_AGENT_DEFINITION,
  IMAGE_HANDLING_RULES,
  blockImageReadHook,
  imageGuardCanUseTool,
  isImagePath,
  IMAGE_EXTENSIONS,
}
