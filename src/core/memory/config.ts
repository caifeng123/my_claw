/**
 * Memory 系统配置常量
 * V5.2 - 存储路径统一至 sessions/{id}/ 目录
 */

export const MEMORY_CONFIG = {
  /** 记忆文件路径（.jsonl）— 兼容旧 DB_PATH 配置名 */
  DB_PATH: process.env.MEMORY_DB_PATH || './data/memory.jsonl',

  /** System Prompt Token 预算 */
  TOKEN_BUDGET: {
    /** SOUL.md 静态层预算 */
    SOUL: 1000,
    /** CLAUDE.md 静态层预算 */
    CLAUDE: 1500,
    /** 动态记忆最小预算 */
    DYNAMIC_MIN: 1000,
    /** 动态记忆最大预算 */
    DYNAMIC_MAX: 4000,
    /** 动态记忆默认预算 */
    DYNAMIC_DEFAULT: 2500,
    /** System Prompt 总硬限 */
    TOTAL_HARD_LIMIT: 5000,
  },

  /** 记忆容量管理 */
  CAPACITY: {
    /** 最大记忆条数（触发淘汰） */
    MAX_ENTRIES: 150,
    /** 淘汰后保留条数 */
    KEEP_ENTRIES: 100,
    /** 衰减半衰期（小时） */
    DECAY_HALF_LIFE_HOURS: 720,
  },

  /** 去重配置 */
  DEDUP: {
    /** Jaccard 相似度阈值 */
    JACCARD_THRESHOLD: 0.8,
    /** AI 去重间隔（小时） */
    AI_INTERVAL_HOURS: 24,
    /** AI 去重触发条数 */
    AI_TRIGGER_COUNT: 50,
  },

  /** 上下文构建配置 */
  CONTEXT: {
    /** 最大上下文 token 数 */
    MAX_CONTEXT_TOKENS: 180000,
    /** 输出预留空间 */
    OUTPUT_RESERVE: 20000,
    /** 摘要预算 */
    SUMMARY_BUDGET: 2000,
    /** 压缩触发阈值（token） */
    COMPRESS_THRESHOLD: 8000,
    /** 最少轮数才压缩 */
    MIN_ROUNDS_FOR_COMPRESS: 6,
    /** 保鲜区最少轮数 */
    RECENT_WINDOW_MIN: 4,
    /** 压缩输出最大 token */
    COMPRESS_MAX_TOKENS: 1000,
  },

  /** 对话文件管理 */
  CONVERSATION: {
    /** 单文件最大大小（10MB） */
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    /** 最多保留的旧文件数 */
    MAX_ROTATED_FILES: 3,
  },
} as const

/** 记忆分类类型 */
export type MemoryCat = 'preference' | 'decision' | 'context' | 'correction' | 'instruction' | 'knowledge'

/** 记忆来源类型 */
export type MemorySource = 'USER' | 'PROJECT' | 'GLOBAL'

/** 所有合法分类值 */
export const MEMORY_CATEGORIES: MemoryCat[] = [
  'preference', 'decision', 'context', 'correction', 'instruction', 'knowledge',
]

/** 所有合法来源值 */
export const MEMORY_SOURCES: MemorySource[] = ['USER', 'PROJECT', 'GLOBAL']

/**
 * 估算文本的 token 数量
 * 中文字符约 1.5 token，英文字符约 0.25 token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length || 0
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25)
}

/**
 * 自适应动态记忆 Budget
 * 根据对话已用 token 动态调整记忆注入量
 */
export function getDynamicMemoryBudget(conversationTokens: number): number {
  const { MAX_CONTEXT_TOKENS } = MEMORY_CONFIG.CONTEXT
  const { DYNAMIC_MIN, DYNAMIC_MAX, DYNAMIC_DEFAULT } = MEMORY_CONFIG.TOKEN_BUDGET
  const remaining = MAX_CONTEXT_TOKENS - DYNAMIC_DEFAULT - conversationTokens
  return Math.max(DYNAMIC_MIN, Math.min(DYNAMIC_MAX, Math.floor(remaining * 0.1)))
}

/** 压缩系统提示词 */
export const COMPRESS_SYSTEM_PROMPT = `你是对话摘要助手。将对话历史压缩成结构化摘要。

要求：
1. 保留所有【关键决定】【用户偏好】【技术选型】【待办事项】
2. 保留具体的代码文件名、函数名、配置值等细节
3. 丢弃寒暄、重复确认、中间调试过程
4. 如果有之前的摘要，在其基础上追加/合并
5. 控制在 500 字以内

输出格式：
### 关键决定
- ...
### 讨论话题
- ...
### 待办/未完成
- ...
### 重要细节
- ...`
