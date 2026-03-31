/**
 * IdentityResolver — 飞书 openId → 用户信息（姓名/邮箱）的持久化缓存
 *
 * 设计原则：
 *   - 默认永久缓存：openId → 姓名/邮箱 几乎不变，无需 TTL
 *   - 持久化到磁盘：bot 重启后不丢缓存，不需要重新调 API
 *   - 提供 refreshUser()：万一有人改名了，可手动刷新
 *   - 批量解析时效率高：已缓存的直接返回，只有新 openId 才调 API
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';

export interface UserInfo {
  openId: string;
  name: string;
  enName?: string;
  email?: string;
  avatarUrl?: string;
  resolvedAt: string; // ISO 时间戳，记录首次解析时间
}

export class IdentityResolver {
  private userCache: Map<string, UserInfo> = new Map();
  private persistPath: string;
  private getClient: () => lark.Client | null;
  /** 防止并发写磁盘 */
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param persistPath 持久化 JSON 文件路径
   * @param getClient 获取飞书 SDK Client 的函数（延迟绑定，避免循环依赖）
   */
  constructor(persistPath: string, getClient: () => lark.Client | null) {
    this.persistPath = persistPath;
    this.getClient = getClient;
    this.loadFromDisk();
  }

  // ─── 核心方法 ───

  /**
   * 解析单个用户 openId → UserInfo
   * 优先走内存缓存，缓存不命中才调飞书 API
   */
  async resolveUser(openId: string): Promise<UserInfo | null> {
    // 1. 内存缓存命中 → 直接返回
    const cached = this.userCache.get(openId);
    if (cached) return cached;

    // 2. 调飞书 API
    const client = this.getClient();
    if (!client) {
      console.warn('[IdentityResolver] Feishu client not available, cannot resolve user');
      return null;
    }

    try {
      const resp = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });

      const user = (resp as any)?.data?.user;
      if (!user) return null;

      const info: UserInfo = {
        openId,
        name: user.name ?? '',
        enName: user.en_name,
        email: user.email,
        avatarUrl: user.avatar?.avatar_240,
        resolvedAt: new Date().toISOString(),
      };

      // 3. 写入内存 + 标记脏数据（延迟持久化）
      this.userCache.set(openId, info);
      this.scheduleSave();

      console.log(`[IdentityResolver] Resolved user: ${openId} → ${info.name}`);
      return info;
    } catch (error) {
      console.warn(`[IdentityResolver] Failed to resolve user ${openId}:`, error);
      return null;
    }
  }

  /**
   * 批量解析用户（并行，最多 10 并发）
   */
  async resolveUsers(openIds: string[]): Promise<Map<string, UserInfo>> {
    const results = new Map<string, UserInfo>();
    const toResolve: string[] = [];

    // 先检查缓存
    for (const id of openIds) {
      const cached = this.userCache.get(id);
      if (cached) {
        results.set(id, cached);
      } else {
        toResolve.push(id);
      }
    }

    // 分批并行解析
    const BATCH_SIZE = 10;
    for (let i = 0; i < toResolve.length; i += BATCH_SIZE) {
      const batch = toResolve.slice(i, i + BATCH_SIZE);
      const promises = batch.map(id => this.resolveUser(id));
      const resolved = await Promise.allSettled(promises);

      for (let j = 0; j < batch.length; j++) {
        const result = resolved[j];
        if (result?.status === 'fulfilled' && result.value) {
          results.set(batch[j]!, result.value);
        }
      }
    }

    return results;
  }

  /**
   * 从缓存中直接获取（不调 API），用于同步场景
   */
  getCached(openId: string): UserInfo | null {
    return this.userCache.get(openId) ?? null;
  }

  /**
   * 强制刷新某个用户（用户改名等极少场景）
   */
  async refreshUser(openId: string): Promise<UserInfo | null> {
    this.userCache.delete(openId);
    return this.resolveUser(openId);
  }

  /**
   * 手动将已知信息写入缓存（如从 mention 事件中获得的姓名）
   * 不覆盖已有的更完整记录
   */
  cacheFromMention(openId: string, name: string): void {
    if (this.userCache.has(openId)) return; // 已有更完整的记录，不覆盖
    this.userCache.set(openId, {
      openId,
      name,
      resolvedAt: new Date().toISOString(),
    });
    this.scheduleSave();
  }

  /**
   * 获取当前缓存大小
   */
  get cacheSize(): number {
    return this.userCache.size;
  }

  // ─── 持久化 ───

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const data = readFileSync(this.persistPath, 'utf-8');
      const entries: [string, UserInfo][] = JSON.parse(data);
      this.userCache = new Map(entries);
      console.log(`[IdentityResolver] Loaded ${this.userCache.size} cached users from disk`);
    } catch (error) {
      console.warn('[IdentityResolver] Failed to load cache from disk:', error);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify([...this.userCache.entries()], null, 2);
      writeFileSync(this.persistPath, data, 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error('[IdentityResolver] Failed to save cache to disk:', error);
    }
  }

  /**
   * 延迟写盘：多次连续写入合并为一次磁盘 IO
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        this.saveToDisk();
      }
    }, 2000); // 2 秒内的多次写入合并
  }

  /**
   * 立即持久化（用于进程退出前）
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.saveToDisk();
    }
  }
}
