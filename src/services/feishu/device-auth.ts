/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) - 飞书/Lark 实现
 *
 * 用于获取用户身份的 access_token，使飞书 API 调用以用户身份执行。
 * 流程：设备码授权 → 用户扫码/访问链接授权 → 获取 user_access_token → 自动刷新
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getAllScopes } from '../../config/feishu-scopes.js';

// ========== 类型定义 ==========

export type Platform = 'feishu' | 'lark';

interface PlatformUrls {
  device_auth_url: string;
  token_url: string;
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * Token 数据结构
 *
 * 使用绝对时间戳 expires_at_ms / refresh_expires_at_ms 判断过期。
 */
export interface TokenData {
  access_token: string;
  token_type: string;
  /** access_token 过期的绝对时间戳 (ms) */
  expires_at_ms: number;
  /** refresh_token 过期的绝对时间戳 (ms)，无 refresh_token 时与 expires_at_ms 相同 */
  refresh_expires_at_ms: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * token.json 持久化文件格式（使用 ISO 8601 时间字符串）
 */
interface TokenFile {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;            // ISO 8601
  refresh_expires_at: string;    // ISO 8601
  scope: string;
}

export interface DeviceAuthClientConfig {
  appId: string;
  appSecret: string;
  platform?: Platform;
  /** token 持久化文件路径，默认 data/temp/feishu-user-token.json */
  tokenFilePath?: string;
  /** access_token 提前刷新的缓冲时间(秒)，默认 300 (5分钟) */
  refreshBufferSeconds?: number;
}

// ========== 平台配置 ==========

const PLATFORM_CONFIG: Record<Platform, PlatformUrls> = {
  feishu: {
    device_auth_url: 'https://accounts.feishu.cn/oauth/v1/device_authorization',
    token_url: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  },
  lark: {
    device_auth_url: 'https://accounts.larksuite.com/oauth/v1/device_authorization',
    token_url: 'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
  },
};

/** 默认 token 文件路径 */
const DEFAULT_TOKEN_PATH = resolve(process.cwd(), 'data', 'temp', 'feishu-user-token.json');

/** refresh_token 默认有效期 30 天 (秒) */
const DEFAULT_REFRESH_EXPIRES_IN = 30 * 24 * 3600;

// ========== DeviceAuthClient ==========

export class DeviceAuthClient {
  private appId: string;
  private appSecret: string;
  private platformUrls: PlatformUrls;
  private basicAuth: string;
  private tokenFilePath: string;
  private refreshBufferSeconds: number;
  private cachedToken: TokenData | null = null;

  /**
   * 记住最近一次请求授权时使用的 scope。
   *
   * 优先级链：
   *   服务器返回 data.scope > this.requestedScope > getAllScopes()
   *
   * 保证 token.json 里的 scope 永远不为空。
   */
  private requestedScope: string = '';

  constructor(config: DeviceAuthClientConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.platformUrls = PLATFORM_CONFIG[config.platform ?? 'feishu'];
    this.basicAuth = btoa(`${config.appId}:${config.appSecret}`);
    this.tokenFilePath = config.tokenFilePath ?? DEFAULT_TOKEN_PATH;
    this.refreshBufferSeconds = config.refreshBufferSeconds ?? 300;

    // 启动时尝试从文件加载 token
    this.loadTokenFromFile();
  }

  /**
   * 获取当前有效的 scope（永不返回空字符串）
   */
  private getEffectiveScope(candidates: (string | undefined)[]): string {
    for (const s of candidates) {
      if (s && s.trim()) return s.trim();
    }
    // 兜底：使用配置文件中的全量 scope
    return getAllScopes();
  }

  // ==================== Token 持久化 ====================

  /**
   * 从 token.json 加载
   */
  private loadTokenFromFile(): void {
    try {
      if (!existsSync(this.tokenFilePath)) return;

      const raw = readFileSync(this.tokenFilePath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.expires_at && data.access_token) {
        this.cachedToken = this.fromFileFormat(data as TokenFile);
        this.requestedScope = this.getEffectiveScope([data.scope]);
      } else {
        return;
      }

      console.log(`[DeviceAuth] 从 ${this.tokenFilePath} 加载 token 成功`);
    } catch (err) {
      console.warn('[DeviceAuth] 加载 token 文件失败:', err);
      this.cachedToken = null;
    }
  }

  /**
   * 写入 token.json
   */
  private saveTokenToFile(token: TokenData): void {
    try {
      const dir = dirname(this.tokenFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const fileFormat = this.toFileFormat(token);
      writeFileSync(this.tokenFilePath, JSON.stringify(fileFormat, null, 2), 'utf-8');
      console.log(`[DeviceAuth] token 已保存到 ${this.tokenFilePath}`);
    } catch (err) {
      console.warn('[DeviceAuth] 保存 token 文件失败:', err);
    }
  }

  /**
   * 文件格式 → 内部格式
   */
  private fromFileFormat(file: TokenFile): TokenData {
    const expiresAtMs = new Date(file.expires_at).getTime();

    let refreshExpiresAtMs: number;
    if (file.refresh_token) {
      refreshExpiresAtMs = file.refresh_expires_at
        ? new Date(file.refresh_expires_at).getTime()
        : Date.now() + DEFAULT_REFRESH_EXPIRES_IN * 1000;
    } else {
      refreshExpiresAtMs = expiresAtMs;
    }

    return {
      access_token: file.access_token,
      token_type: file.token_type ?? 'Bearer',
      expires_at_ms: expiresAtMs,
      refresh_expires_at_ms: refreshExpiresAtMs,
      refresh_token: file.refresh_token || undefined,
      scope: this.getEffectiveScope([file.scope]),
    };
  }

  /**
   * 内部格式 → 文件格式
   */
  private toFileFormat(token: TokenData): TokenFile {
    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? '',
      token_type: token.token_type,
      expires_at: new Date(token.expires_at_ms).toISOString(),
      refresh_expires_at: new Date(token.refresh_expires_at_ms).toISOString(),
      scope: this.getEffectiveScope([token.scope, this.requestedScope]),
    };
  }

  // ==================== Token 有效性检查 ====================

  /**
   * 基于绝对时间判断 access_token 是否过期
   * 提前 refreshBufferSeconds 秒视为"即将过期"
   */
  private isAccessTokenExpired(token: TokenData): boolean {
    return Date.now() >= (token.expires_at_ms - this.refreshBufferSeconds * 1000);
  }

  /**
   * 基于绝对时间判断 refresh_token 是否过期
   */
  private isRefreshTokenExpired(token: TokenData): boolean {
    return Date.now() >= token.refresh_expires_at_ms;
  }

  /**
   * 获取有效的 user_access_token
   * 优先使用缓存，过期则自动刷新，无 token 则返回 null（需要发起设备授权流程）
   */
  async getValidAccessToken(): Promise<string | null> {
    if (!this.cachedToken) {
      return null;
    }

    // access_token 未过期，直接返回
    if (!this.isAccessTokenExpired(this.cachedToken)) {
      return this.cachedToken.access_token;
    }

    // access_token 已过期，尝试用 refresh_token 刷新
    if (this.cachedToken.refresh_token) {
      // 先检查 refresh_token 本身是否也过期了
      if (this.isRefreshTokenExpired(this.cachedToken)) {
        console.warn('[DeviceAuth] refresh_token 也已过期，需要重新授权');
        this.cachedToken = null;
        return null;
      }

      try {
        console.log('[DeviceAuth] access_token 已过期，尝试刷新...');
        const newToken = await this.refreshAccessToken(this.cachedToken.refresh_token);
        this.cachedToken = newToken;
        this.saveTokenToFile(newToken);
        console.log('[DeviceAuth] token 刷新成功，已更新 token.json');
        return newToken.access_token;
      } catch (err) {
        console.warn('[DeviceAuth] token 刷新失败，需要重新授权:', err);
        this.cachedToken = null;
        return null;
      }
    }

    console.warn('[DeviceAuth] token 过期且无 refresh_token，需要重新授权');
    console.warn('[DeviceAuth] 提示：授权时 scope 需包含 offline_access 才能获得 refresh_token');
    this.cachedToken = null;
    return null;
  }

  /**
   * 强制刷新 token，不检查 access_token 是否过期。
   * 用于服务启动时确保拿到完整有效期的 token。
   * 返回 true 表示刷新成功，false 表示无法刷新（无 token 或无 refresh_token）。
   */
  async forceRefresh(): Promise<boolean> {
    if (!this.cachedToken || !this.cachedToken.refresh_token) {
      return false;
    }

    if (this.isRefreshTokenExpired(this.cachedToken)) {
      console.warn('[DeviceAuth] refresh_token 已过期，无法强制刷新，需要重新授权');
      this.cachedToken = null;
      return false;
    }

    try {
      console.log('[DeviceAuth] 强制刷新 token...');
      const newToken = await this.refreshAccessToken(this.cachedToken.refresh_token);
      this.cachedToken = newToken;
      this.saveTokenToFile(newToken);
      console.log('[DeviceAuth] 强制刷新成功，token 有效期已重置');
      return true;
    } catch (err) {
      console.warn('[DeviceAuth] 强制刷新失败:', err);
      return false;
    }
  }

  /**
   * 检查是否已有有效的用户授权（不触发刷新）
   */
  hasValidToken(): boolean {
    return this.cachedToken !== null && !this.isAccessTokenExpired(this.cachedToken);
  }

  // ==================== Step 1: 设备授权请求 ====================

  async requestDeviceAuthorization(scope: string = 'offline_access'): Promise<DeviceAuthResponse> {
    // 确保 scope 包含 offline_access（否则拿不到 refresh_token）
    if (!scope.includes('offline_access')) {
      scope = `offline_access ${scope}`;
      console.log('[DeviceAuth] 自动追加 offline_access 到 scope');
    }

    // 记住本次请求的完整 scope，后续写入 token.json 时使用
    this.requestedScope = scope;

    const resp = await fetch(this.platformUrls.device_auth_url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ scope }),
    });

    if (!resp.ok) {
      throw new Error(`Device authorization request failed: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as any;

    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete,
      expires_in: data.expires_in,
      interval: data.interval ?? 5,
    };
  }

  // ==================== Step 2: 轮询获取 Token ====================

  async pollForToken(deviceCode: string, interval: number = 5, timeout: number = 300): Promise<TokenData> {
    const startTime = Date.now();
    let currentInterval = interval;

    while ((Date.now() - startTime) / 1000 < timeout) {
      await this.sleep(currentInterval * 1000);

      const resp = await fetch(this.platformUrls.token_url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${this.basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        }),
      });

      const data = await resp.json() as any;

      if (resp.ok && data.access_token) {
        const now = Date.now();
        const expiresIn = data.expires_in ?? 7200;

        // 有 refresh_token 时用服务器返回的有效期，否则 = access_token 有效期
        const hasRefresh = !!data.refresh_token;
        const refreshExpiresIn = hasRefresh
          ? (data.refresh_expires_in ?? DEFAULT_REFRESH_EXPIRES_IN)
          : expiresIn;

        if (!hasRefresh) {
          console.warn('[DeviceAuth] ⚠️ 服务器未返回 refresh_token！scope 是否包含 offline_access？');
        }

        const token: TokenData = {
          access_token: data.access_token,
          token_type: data.token_type ?? 'Bearer',
          expires_at_ms: now + expiresIn * 1000,
          refresh_expires_at_ms: now + refreshExpiresIn * 1000,
          refresh_token: data.refresh_token || undefined,
          scope: this.getEffectiveScope([data.scope, this.requestedScope]),
        };

        this.cachedToken = token;
        this.saveTokenToFile(token);

        return token;
      }

      const error = data.error ?? '';

      if (error === 'authorization_pending') {
        continue;
      } else if (error === 'slow_down') {
        currentInterval += 5;
        console.log(`[DeviceAuth] slow_down, 轮询间隔调整为 ${currentInterval}s`);
        continue;
      } else if (error === 'expired_token') {
        throw new Error('device_code 已过期，需重新发起授权');
      } else if (error === 'access_denied') {
        throw new Error('用户拒绝了授权');
      } else {
        throw new Error(`轮询错误: ${JSON.stringify(data)}`);
      }
    }

    throw new Error(`轮询超时 (${timeout}s)，用户未完成授权`);
  }

  // ==================== Step 3: 刷新 Token ====================

  async refreshAccessToken(refreshToken: string): Promise<TokenData> {
    const resp = await fetch(this.platformUrls.token_url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Token 刷新失败: ${resp.status} ${errText}`);
    }

    const data = await resp.json() as any;
    const now = Date.now();
    const expiresIn = data.expires_in ?? 7200;
    const hasRefresh = !!data.refresh_token;
    const refreshExpiresIn = hasRefresh
      ? (data.refresh_expires_in ?? DEFAULT_REFRESH_EXPIRES_IN)
      : expiresIn;

    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'Bearer',
      expires_at_ms: now + expiresIn * 1000,
      refresh_expires_at_ms: now + refreshExpiresIn * 1000,
      refresh_token: data.refresh_token || refreshToken,
      scope: this.getEffectiveScope([data.scope, this.requestedScope, this.cachedToken?.scope]),
    };
  }

  /**
   * 清除本地存储的 token（用于手动登出）
   */
  clearToken(): void {
    this.cachedToken = null;
    this.requestedScope = '';
    try {
      if (existsSync(this.tokenFilePath)) {
        writeFileSync(this.tokenFilePath, '{}', 'utf-8');
      }
    } catch {}
  }

  /**
   * 获取当前 token 状态摘要
   */
  getTokenStatus(): {
    hasToken: boolean;
    accessTokenValid: boolean;
    accessExpiresAt: string | null;
    refreshTokenValid: boolean;
    refreshExpiresAt: string | null;
  } {
    if (!this.cachedToken) {
      return {
        hasToken: false,
        accessTokenValid: false,
        accessExpiresAt: null,
        refreshTokenValid: false,
        refreshExpiresAt: null,
      };
    }
    return {
      hasToken: true,
      accessTokenValid: !this.isAccessTokenExpired(this.cachedToken),
      accessExpiresAt: new Date(this.cachedToken.expires_at_ms).toISOString(),
      refreshTokenValid: !!this.cachedToken.refresh_token && !this.isRefreshTokenExpired(this.cachedToken),
      refreshExpiresAt: new Date(this.cachedToken.refresh_expires_at_ms).toISOString(),
    };
  }

  // ==================== 辅助方法 ====================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
