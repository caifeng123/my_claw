/**
 * SessionIdStore - 业务 sessionId → SDK session_id 的持久化映射
 *
 * Resume 模式下，SDK 每次 query() 会返回一个 session_id，
 * 后续调用需要把这个 session_id 传给 resume 参数以续接对话。
 * 本模块负责持久化存储该映射，使进程重启后仍可恢复会话。
 *
 * 存储路径: data/sdk-session-map.json
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const STORE_PATH = path.join('data', 'sdk-session-map.json')

interface SessionMapEntry {
  /** SDK 分配的 session_id（用于 resume） */
  sdkSessionId: string
  /** 最后更新时间 */
  updatedAt: string
}

export class SessionIdStore {
  private map: Record<string, SessionMapEntry> = {}

  constructor() {
    this.load()
  }

  /** 获取 SDK session_id */
  get(sessionId: string): string | undefined {
    return this.map[sessionId]?.sdkSessionId
  }

  /** 记录 SDK session_id */
  set(sessionId: string, sdkSessionId: string): void {
    this.map[sessionId] = {
      sdkSessionId,
      updatedAt: new Date().toISOString(),
    }
    this.persist()
  }

  /** 删除映射 */
  delete(sessionId: string): void {
    delete this.map[sessionId]
    this.persist()
  }

  /** 检查是否存在 */
  has(sessionId: string): boolean {
    return sessionId in this.map
  }

  /** 列出所有映射 */
  listAll(): Record<string, SessionMapEntry> {
    return { ...this.map }
  }

  /** 清理过期映射（默认 7 天） */
  cleanup(maxAgeDays: number = 7): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let cleaned = 0
    for (const [key, entry] of Object.entries(this.map)) {
      if (new Date(entry.updatedAt).getTime() < cutoff) {
        delete this.map[key]
        cleaned++
      }
    }
    if (cleaned > 0) {
      this.persist()
      console.log(`🧹 清理了 ${cleaned} 个过期的 SDK session 映射`)
    }
    return cleaned
  }

  // ==================== 内部方法 ====================

  private load(): void {
    try {
      if (fs.existsSync(STORE_PATH)) {
        const content = fs.readFileSync(STORE_PATH, 'utf-8')
        this.map = JSON.parse(content)
        console.log(`📋 加载 SDK session 映射: ${Object.keys(this.map).length} 条`)
      }
    } catch (error) {
      console.warn('⚠️ 加载 SDK session 映射失败，使用空映射:', error)
      this.map = {}
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(STORE_PATH)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(STORE_PATH, JSON.stringify(this.map, null, 2), 'utf-8')
    } catch (error) {
      console.error('❌ 持久化 SDK session 映射失败:', error)
    }
  }
}
