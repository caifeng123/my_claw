/**
 * MemoryDB - SQLite + FTS5 记忆存储引擎
 * V4.1 - 支持全文搜索、自动去重、容量淘汰
 */

import Database from 'better-sqlite3'
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
  text: string      // 记忆内容（自然语言）
  created_at: string
  updated_at: string
}

export interface SearchResult extends MemoryEntry {
  score: number     // 综合得分
  fts_rank: number  // FTS5 匹配排名
}

export interface MemoryStats {
  total: number
  byCategory: Record<string, number>
  bySource: Record<string, number>
}

export interface DedupLogEntry {
  cat: string
  kept_id: number
  removed_ids: number[]
  merged_text: string
  timestamp: string
}

// ==================== Schema SQL ====================

const SCHEMA_SQL = `
-- 启用 WAL 模式（并发安全）
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- 主表：存储记忆元数据
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'USER',
  cat TEXT NOT NULL,
  imp INTEGER NOT NULL DEFAULT 3 CHECK(imp BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 全文搜索虚拟表
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='id',
  tokenize='unicode61'
);

-- 同步触发器：主表增删改自动同步到 FTS 索引
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

-- 索引
CREATE INDEX IF NOT EXISTS idx_memories_cat ON memories(cat);
CREATE INDEX IF NOT EXISTS idx_memories_imp ON memories(imp DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
`

// ==================== MemoryDB 类 ====================

export class MemoryDB {
  private db: Database.Database

  constructor(dbPath: string = MEMORY_CONFIG.DB_PATH) {
    // 确保目录存在
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.initSchema()
    console.log(`💾 MemoryDB 初始化完成: ${dbPath}`)
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

    if (duplicateCheck.action === 'merge' && duplicateCheck.existingId !== undefined) {
      this.db.prepare(`
        UPDATE memories SET text = ?, imp = MAX(imp, ?), updated_at = datetime('now')
        WHERE id = ?
      `).run(entry.text, entry.imp, duplicateCheck.existingId)
      return 'merged'
    }

    this.db.prepare(`
      INSERT INTO memories (source, cat, imp, text) VALUES (?, ?, ?, ?)
    `).run(entry.source, entry.cat, entry.imp, entry.text)
    return 'added'
  }

  /**
   * 更新指定记忆
   */
  update(id: number, fields: Partial<Pick<MemoryEntry, 'text' | 'imp' | 'cat'>>): void {
    const sets: string[] = []
    const values: unknown[] = []

    if (fields.text !== undefined) { sets.push('text = ?'); values.push(fields.text) }
    if (fields.imp !== undefined) { sets.push('imp = ?'); values.push(fields.imp) }
    if (fields.cat !== undefined) { sets.push('cat = ?'); values.push(fields.cat) }

    if (sets.length === 0) return

    sets.push("updated_at = datetime('now')")
    values.push(id)

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  /**
   * 按 ID 删除
   */
  deleteById(id: number): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  // ==================== 搜索 ====================

  /**
   * FTS5 全文搜索 + 重要性加权排序
   * 直接接受用户消息作为搜索词，FTS5 unicode61 自动分词
   */
  search(query: string, limit: number = 20): SearchResult[] {
    if (!query || !query.trim()) {
      return this.getTopMemories(limit).map(e => ({
        ...e,
        score: e.imp * 2.0,
        fts_rank: 0,
      }))
    }

    const ftsQuery = this.buildFtsQuery(query)

    try {
      return this.db.prepare(`
        SELECT
          m.*,
          fts.rank as fts_rank,
          (m.imp * 2.0 + ABS(fts.rank) * 3.0) as score
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `).all(ftsQuery, limit) as SearchResult[]
    } catch {
      // FTS 查询语法错误时回退到 LIKE 模糊搜索
      return this.db.prepare(`
        SELECT *, imp * 2.0 as score, 0 as fts_rank
        FROM memories
        WHERE text LIKE ?
        ORDER BY score DESC
        LIMIT ?
      `).all(`%${query.slice(0, 50)}%`, limit) as SearchResult[]
    }
  }

  /**
   * 按分类筛选
   */
  getByCategory(cat: string, limit: number = 50): MemoryEntry[] {
    return this.db.prepare(`
      SELECT * FROM memories WHERE cat = ?
      ORDER BY imp DESC, created_at DESC LIMIT ?
    `).all(cat, limit) as MemoryEntry[]
  }

  /**
   * 按来源筛选
   */
  getBySource(source: string, limit: number = 50): MemoryEntry[] {
    return this.db.prepare(`
      SELECT * FROM memories WHERE source = ?
      ORDER BY imp DESC, created_at DESC LIMIT ?
    `).all(source, limit) as MemoryEntry[]
  }

  /**
   * 获取最高重要性记忆（无关键词时的兜底）
   */
  getTopMemories(limit: number = 50): MemoryEntry[] {
    return this.db.prepare(`
      SELECT * FROM memories
      ORDER BY imp DESC, updated_at DESC LIMIT ?
    `).all(limit) as MemoryEntry[]
  }

  /**
   * 获取全部记忆
   */
  getAll(): MemoryEntry[] {
    return this.db.prepare('SELECT * FROM memories ORDER BY created_at').all() as MemoryEntry[]
  }

  /**
   * 统计信息
   */
  getStats(): MemoryStats {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt
    const byCat = this.db.prepare('SELECT cat, COUNT(*) as cnt FROM memories GROUP BY cat').all() as { cat: string; cnt: number }[]
    const bySrc = this.db.prepare('SELECT source, COUNT(*) as cnt FROM memories GROUP BY source').all() as { source: string; cnt: number }[]

    return {
      total,
      byCategory: Object.fromEntries(byCat.map(r => [r.cat, r.cnt])),
      bySource: Object.fromEntries(bySrc.map(r => [r.source, r.cnt])),
    }
  }

  // ==================== 删除 ====================

  /**
   * 安全删除：支持精确匹配 + dry_run 预览
   */
  delete(query: string, options: { exact_match?: boolean; dry_run?: boolean } = {}): {
    count: number
    entries: MemoryEntry[]
  } {
    const { exact_match = false, dry_run = false } = options

    let entries: MemoryEntry[]
    if (exact_match) {
      entries = this.db.prepare('SELECT * FROM memories WHERE text = ?').all(query) as MemoryEntry[]
    } else {
      entries = this.db.prepare('SELECT * FROM memories WHERE text LIKE ?').all(`%${query}%`) as MemoryEntry[]
    }

    if (!dry_run && entries.length > 0) {
      const ids = entries.map(e => e.id)
      this.db.prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    }

    return { count: entries.length, entries }
  }

  // ==================== 淘汰 ====================

  /**
   * 容量淘汰：指数衰减评分，超阈值时淘汰低分记忆
   * 评分公式：imp * exp(-ageHours / 720)
   * 720 小时 = 30 天半衰期
   */
  compact(
    maxEntries: number = MEMORY_CONFIG.CAPACITY.MAX_ENTRIES,
    keepEntries: number = MEMORY_CONFIG.CAPACITY.KEEP_ENTRIES
  ): number {
    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt
    if (count <= maxEntries) return 0

    const toDelete = count - keepEntries

    this.db.prepare(`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories
        ORDER BY imp * EXP(-(julianday('now') - julianday(created_at)) * 24.0 / ${MEMORY_CONFIG.CAPACITY.DECAY_HALF_LIFE_HOURS}.0) ASC
        LIMIT ?
      )
    `).run(toDelete)

    console.log(`🗑️ MemoryDB compact: 淘汰了 ${toDelete} 条记忆`)
    return toDelete
  }

  // ==================== 导出 ====================

  /**
   * 导出全部记忆为 JSONL
   */
  exportToJsonl(outputPath: string): number {
    const entries = this.db.prepare('SELECT * FROM memories ORDER BY created_at').all()
    const lines = entries.map(e => JSON.stringify(e)).join('\n')
    if (outputPath === '/dev/stdout') {
      process.stdout.write(lines + '\n')
    } else {
      fs.writeFileSync(outputPath, lines + '\n')
    }
    return entries.length
  }

  /**
   * 数据库备份
   */
  backup(backupPath: string): void {
    const dir = path.dirname(backupPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.db.backup(backupPath)
    console.log(`💾 MemoryDB 备份完成: ${backupPath}`)
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close()
  }

  // ==================== 内部方法 ====================

  /**
   * 写入时轻量去重：精确匹配 + Jaccard 相似度
   */
  private checkDuplicate(text: string, cat: string): {
    action: 'add' | 'merge' | 'skip'
    existingId?: number
  } {
    // 1. 精确匹配
    const exact = this.db.prepare('SELECT id FROM memories WHERE text = ? LIMIT 1').get(text) as { id: number } | undefined
    if (exact) return { action: 'skip' }

    // 2. 同分类下的模糊匹配
    const sameCat = this.db.prepare('SELECT id, text FROM memories WHERE cat = ?').all(cat) as MemoryEntry[]
    for (const entry of sameCat) {
      if (this.jaccardSimilarity(text, entry.text) > MEMORY_CONFIG.DEDUP.JACCARD_THRESHOLD) {
        return { action: 'merge', existingId: entry.id }
      }
    }

    return { action: 'add' }
  }

  /**
   * Jaccard 相似度计算
   */
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

  /**
   * 构建 FTS5 查询语法
   * 截取前 100 字符，分词后用 OR 连接，支持前缀匹配
   */
  private buildFtsQuery(query: string): string {
    const trimmed = query.slice(0, 100)
    const tokens = trimmed
      .split(/[\s,;.!?，。；！？、\n]+/)
      .filter(t => t.length > 1)
      .slice(0, 10)             // 最多 10 个关键词
      .map(t => `"${t}"*`)      // 前缀匹配
    return tokens.length > 0 ? tokens.join(' OR ') : `"${trimmed}"*`
  }

  /**
   * 初始化数据库 Schema
   */
  private initSchema(): void {
    this.db.exec(SCHEMA_SQL)
  }
}
