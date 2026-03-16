/**
 * MemoryDB - JSONL 明文记忆存储引擎
 * V5.3 - keywords 索引分离：text 保持简洁，keywords 存同义词/别名用于搜索扩召回
 *
 * 存储格式（data/memory.jsonl）:
 * {"id":1,"source":"USER","cat":"preference","imp":4,"text":"不要使用emoji","keywords":"表情 表情符号 颜文字 emoticon","created_at":"...","updated_at":"..."}
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { MEMORY_CONFIG } from './config.js'
import type { MemoryCat, MemorySource } from './config.js'

// ==================== 类型定义 ====================

export interface MemoryEntry {
  id?: number
  source: MemorySource
  cat: MemoryCat
  imp: number       // 重要性 1-5
  text: string      // 记忆内容（自然语言，简洁）
  keywords: string  // 同义词/别名索引（空格分隔，仅搜索用，不注入 prompt）
  created_at: string
  updated_at: string
}

export interface SearchResult extends MemoryEntry {
  score: number     // 综合得分
  fts_rank: number  // 兼容字段，匹配命中数
}

export interface MemoryStats {
  total: number
  byCategory: Record<string, number>
  bySource: Record<string, number>
}

// ==================== 搜索辅助函数 ====================

/**
 * 提取搜索 token：空格分词 + N-gram 双策略
 *
 * 1. 先按空格/标点切分
 * 2. 对每个切分片段：
 *    - 英文/数字片段保留原样
 *    - 中文片段生成 2-gram 和 3-gram
 * 3. 去重后返回
 */
function extractSearchTokens(text: string): string[] {
  const trimmed = text.slice(0, 100).toLowerCase()

  const segments = trimmed
    .split(/[\s,;.!?，。；！？、\n:：()\[\]{}""''「」【】]+/)
    .filter(s => s.length > 0)

  const tokens = new Set<string>()

  for (const seg of segments) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(seg)

    if (!hasCJK) {
      if (seg.length > 1) tokens.add(seg)
    } else {
      // 英文部分作为整体 token
      const engParts = seg.match(/[a-z0-9]+/gi)
      if (engParts) {
        for (const ep of engParts) {
          if (ep.length > 1) tokens.add(ep.toLowerCase())
        }
      }

      // CJK 连续片段做 N-gram
      const cjkParts = seg.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)
      if (cjkParts) {
        for (const part of cjkParts) {
          if (part.length <= 3) {
            if (part.length >= 2) tokens.add(part)
            continue
          }
          for (let i = 0; i <= part.length - 2; i++) {
            tokens.add(part.slice(i, i + 2))
          }
          for (let i = 0; i <= part.length - 3; i++) {
            tokens.add(part.slice(i, i + 3))
          }
        }
      }
    }
  }

  return [...tokens]
}

// ==================== MemoryDB 类 ====================

export class MemoryDB {
  private filePath: string
  private entries: MemoryEntry[] = []
  private nextId: number = 1

  constructor(dbPath?: string) {
    const rawPath = dbPath || MEMORY_CONFIG.DB_PATH
    this.filePath = rawPath.replace(/\.(db|md)$/, '.jsonl')

    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.load()
    console.log(`📝 MemoryDB (JSONL) 初始化完成: ${this.filePath} (${this.entries.length} entries)`)
  }

  // ==================== 写入 ====================

  /**
   * 插入记忆（含写入时去重）
   * @returns 'added' | 'merged' | 'skipped'
   */
  insert(entry: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at'>): string {
    const duplicateCheck = this.checkDuplicate(entry.text, entry.cat)

    if (duplicateCheck.action === 'skip') {
      return 'skipped'
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    if (duplicateCheck.action === 'merge' && duplicateCheck.existingId !== undefined) {
      const existing = this.entries.find(e => e.id === duplicateCheck.existingId)
      if (existing) {
        existing.text = entry.text
        existing.keywords = entry.keywords || existing.keywords
        existing.imp = Math.max(existing.imp, entry.imp)
        existing.updated_at = now
        this.rewrite()
      }
      return 'merged'
    }

    const newEntry: MemoryEntry = {
      id: this.nextId++,
      source: entry.source,
      cat: entry.cat,
      imp: entry.imp,
      text: entry.text,
      keywords: entry.keywords || '',
      created_at: now,
      updated_at: now,
    }
    this.entries.push(newEntry)
    this.appendOne(newEntry)
    return 'added'
  }

  /**
   * 更新指定记忆
   */
  update(id: number, fields: Partial<Pick<MemoryEntry, 'text' | 'imp' | 'cat' | 'keywords'>>): void {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return

    if (fields.text !== undefined) entry.text = fields.text
    if (fields.imp !== undefined) entry.imp = fields.imp
    if (fields.cat !== undefined) entry.cat = fields.cat
    if (fields.keywords !== undefined) entry.keywords = fields.keywords
    entry.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19)

    this.rewrite()
  }

  /**
   * 按 ID 删除
   */
  deleteById(id: number): void {
    this.entries = this.entries.filter(e => e.id !== id)
    this.rewrite()
  }

  // ==================== 搜索 ====================

  /**
   * N-gram + 关键词搜索 + 重要性加权排序
   *
   * 搜索策略：
   * 1. 从 query 中提取 token（英文保留原词，中文生成 2/3-gram）
   * 2. 对每条记忆同时匹配 text 和 keywords 两个字段
   * 3. text 命中权重 1.0，keywords 命中权重 0.6（避免同义词膨胀导致分数反超）
   * 4. 综合得分 = imp × 2 + normalizedMatch × 3
   */
  search(query: string, limit: number = 20): SearchResult[] {
    if (!query || !query.trim()) {
      return this.getTopMemories(limit).map(e => ({
        ...e,
        score: e.imp * 2.0,
        fts_rank: 0,
      }))
    }

    const tokens = extractSearchTokens(query)

    if (tokens.length === 0) {
      return this.getTopMemories(limit).map(e => ({
        ...e,
        score: e.imp * 2.0,
        fts_rank: 0,
      }))
    }

    const scored: SearchResult[] = []

    for (const entry of this.entries) {
      const textLower = entry.text.toLowerCase()
      const kwLower = (entry.keywords || '').toLowerCase()

      let weightedMatch = 0
      let rawMatchCount = 0

      for (const token of tokens) {
        const inText = textLower.includes(token)
        const inKw = kwLower.includes(token)

        if (inText || inKw) {
          rawMatchCount++
          // text 命中权重 1.0，keywords 命中权重 0.6，两者都命中取 1.0
          weightedMatch += inText ? 1.0 : 0.6
        }
      }

      if (rawMatchCount > 0) {
        const normalizedMatch = (weightedMatch / tokens.length) * Math.min(tokens.length, 10)
        scored.push({
          ...entry,
          fts_rank: rawMatchCount,
          score: entry.imp * 2.0 + normalizedMatch * 3.0,
        })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /**
   * 按分类筛选
   */
  getByCategory(cat: string, limit: number = 50): MemoryEntry[] {
    return this.entries
      .filter(e => e.cat === cat)
      .sort((a, b) => b.imp - a.imp || b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
  }

  /**
   * 按来源筛选
   */
  getBySource(source: string, limit: number = 50): MemoryEntry[] {
    return this.entries
      .filter(e => e.source === source)
      .sort((a, b) => b.imp - a.imp || b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
  }

  /**
   * 获取最高重要性记忆
   */
  getTopMemories(limit: number = 50): MemoryEntry[] {
    return [...this.entries]
      .sort((a, b) => b.imp - a.imp || b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
  }

  /**
   * 获取全部记忆
   */
  getAll(): MemoryEntry[] {
    return [...this.entries].sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  /**
   * 统计信息
   */
  getStats(): MemoryStats {
    const byCategory: Record<string, number> = {}
    const bySource: Record<string, number> = {}

    for (const entry of this.entries) {
      byCategory[entry.cat] = (byCategory[entry.cat] || 0) + 1
      bySource[entry.source] = (bySource[entry.source] || 0) + 1
    }

    return {
      total: this.entries.length,
      byCategory,
      bySource,
    }
  }

  // ==================== 删除 ====================

  delete(query: string, options: { exact_match?: boolean; dry_run?: boolean } = {}): {
    count: number
    entries: MemoryEntry[]
  } {
    const { exact_match = false, dry_run = false } = options

    let matched: MemoryEntry[]
    if (exact_match) {
      matched = this.entries.filter(e => e.text === query)
    } else {
      matched = this.entries.filter(e => e.text.includes(query))
    }

    if (!dry_run && matched.length > 0) {
      const ids = new Set(matched.map(e => e.id))
      this.entries = this.entries.filter(e => !ids.has(e.id))
      this.rewrite()
    }

    return { count: matched.length, entries: matched }
  }

  // ==================== 淘汰 ====================

  compact(
    maxEntries: number = MEMORY_CONFIG.CAPACITY.MAX_ENTRIES,
    keepEntries: number = MEMORY_CONFIG.CAPACITY.KEEP_ENTRIES
  ): number {
    if (this.entries.length <= maxEntries) return 0

    const toDelete = this.entries.length - keepEntries
    const now = Date.now()

    const scored = this.entries.map(entry => {
      const createdTime = new Date(entry.created_at).getTime()
      const ageHours = (now - createdTime) / (1000 * 60 * 60)
      const decayScore = entry.imp * Math.exp(-ageHours / MEMORY_CONFIG.CAPACITY.DECAY_HALF_LIFE_HOURS)
      return { entry, decayScore }
    })

    scored.sort((a, b) => a.decayScore - b.decayScore)
    const idsToRemove = new Set(scored.slice(0, toDelete).map(s => s.entry.id))
    this.entries = this.entries.filter(e => !idsToRemove.has(e.id))
    this.rewrite()

    console.log(`🗑️ MemoryDB compact: 淘汰了 ${toDelete} 条记忆`)
    return toDelete
  }

  // ==================== 导出 ====================

  exportToJsonl(outputPath: string): number {
    const lines = this.entries.map(e => JSON.stringify(e)).join('\n')
    if (outputPath === '/dev/stdout') {
      process.stdout.write(lines + '\n')
    } else {
      fs.writeFileSync(outputPath, lines + '\n')
    }
    return this.entries.length
  }

  backup(backupPath: string): void {
    const dir = path.dirname(backupPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const targetPath = backupPath.replace(/\.(db|md)$/, '.jsonl')
    fs.copyFileSync(this.filePath, targetPath)
    console.log(`📝 MemoryDB 备份完成: ${targetPath}`)
  }

  close(): void {
    // no-op
  }

  // ==================== 内部方法：持久化 ====================

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.entries = []
      this.nextId = 1
      return
    }

    const content = fs.readFileSync(this.filePath, 'utf-8')
    this.entries = []
    let maxId = 0

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line) as Record<string, unknown>
        // 兼容旧数据：没有 keywords 字段的补空字符串
        const entry: MemoryEntry = {
          id: raw.id as number,
          source: raw.source as MemorySource,
          cat: raw.cat as MemoryCat,
          imp: raw.imp as number,
          text: raw.text as string,
          keywords: (raw.keywords as string) || '',
          created_at: raw.created_at as string,
          updated_at: raw.updated_at as string,
        }
        this.entries.push(entry)
        if (entry.id !== undefined && entry.id > maxId) {
          maxId = entry.id
        }
      } catch {
        console.warn(`⚠️ 跳过损坏的记忆行: ${line.slice(0, 80)}...`)
      }
    }

    this.nextId = maxId + 1
  }

  private appendOne(entry: MemoryEntry): void {
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  private rewrite(): void {
    const lines = this.entries.map(e => JSON.stringify(e)).join('\n')
    fs.writeFileSync(this.filePath, lines ? lines + '\n' : '', 'utf-8')
  }

  // ==================== 内部方法：去重 ====================

  private checkDuplicate(text: string, cat: string): {
    action: 'add' | 'merge' | 'skip'
    existingId?: number
  } {
    const exact = this.entries.find(e => e.text === text)
    if (exact) return { action: 'skip' }

    const sameCat = this.entries.filter(e => e.cat === cat)
    for (const entry of sameCat) {
      if (this.jaccardSimilarity(text, entry.text) > MEMORY_CONFIG.DEDUP.JACCARD_THRESHOLD) {
        return { action: 'merge', existingId: entry.id }
      }
    }

    return { action: 'add' }
  }

  private jaccardSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(
      s.toLowerCase()
        .split(/[\s,;.!?，。；！？、\n]+/)
        .filter(Boolean)
    )
    const setA = tokenize(a)
    const setB = tokenize(b)
    const intersection = new Set([...setA].filter(x => setB.has(x)))
    const union = new Set([...setA, ...setB])
    return union.size === 0 ? 0 : intersection.size / union.size
  }
}
