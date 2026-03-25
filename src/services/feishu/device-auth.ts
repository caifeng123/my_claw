/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) - 飞书/Lark 实现
 *
 * 用于获取用户身份的 access_token，使飞书 API 调用以用户身份执行。
 * 流程：设备码授权 → 用户扫码/访问链接授权 → 获取 user_access_token → 自动刷新
 *
 * Token 持久化格式兼容 feishu-cli 的 ~/.feishu-cli/token.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

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
 * 内部 token 数据结构（运行时使用）
 */
export interface TokenData {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  /** 获取时间戳(ms) */
  obtained_at: number;
}

/**
 * feishu-cli 兼容的 token.json 文件格式
 * 使用 ISO 8601 时间字符串表示过期时间
 */
interface CliTokenFile {
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
  /** token 持久化文件路径，默认 ~/.feishu-cli/token.json */
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

/** 默认 token 文件路径: ~/.feishu-cli/token.json */
const DEFAULT_TOKEN_PATH = join(homedir(), '.feishu-cli', 'token.json');

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
   * 用于写入 token.json 时保证 scope 字段完整——
   * 因为飞书服务器响应中 data.scope 可能为空或仅返回部分。
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

  // ==================== Token 持久化（兼容 feishu-cli 格式） ====================

  /**
   * 从 feishu-cli 格式的 token.json 加载
   */
  private loadTokenFromFile(): void {
    try {
      if (!existsSync(this.tokenFilePath)) return;

      const raw = readFileSync(this.tokenFilePath, 'utf-8');
      const data = JSON.parse(raw);

      // 兼容 feishu-cli 格式（有 expires_at 字段）
      if (data.expires_at) {
        this.cachedToken = this.fromCliFormat(data as CliTokenFile);
        // 从文件中恢复已记录的 scope
        if (data.scope) {
          this.requestedScope = data.scope;
        }
      }
      // 兼容旧格式（有 obtained_at 字段）
      else if (data.obtained_at) {
        this.cachedToken = data as TokenData;
        if (data.scope) {
          this.requestedScope = data.scope;
        }
      }
      // 空对象或无效格式
      else if (data.access_token) {
        this.cachedToken = {
          access_token: data.access_token,
          token_type: data.token_type ?? 'Bearer',
          expires_in: data.expires_in ?? 7200,
          refresh_token: data.refresh_token,
          scope: data.scope,
          obtained_at: Date.now(),
        };
        if (data.scope) {
          this.requestedScope = data.scope;
        }
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
   * 以 feishu-cli 兼容格式写入 token.json
   */
  private saveTokenToFile(token: TokenData): void {
    try {
      const dir = dirname(this.tokenFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const cliFormat = this.toCliFormat(token);
      writeFileSync(this.tokenFilePath, JSON.stringify(cliFormat, null, 2), 'utf-8');
      console.log(`[DeviceAuth] token 已保存到 ${this.tokenFilePath}`);
    } catch (err) {
      console.warn('[DeviceAuth] 保存 token 文件失败:', err);
    }
  }

  /**
   * feishu-cli 格式 → 内部格式
   */
  private fromCliFormat(cli: CliTokenFile): TokenData {
    const expiresAt = new Date(cli.expires_at).getTime();
    const now = Date.now();
    const remainingSeconds = Math.max(0, (expiresAt - now) / 1000);

    return {
      access_token: cli.access_token,
      token_type: cli.token_type ?? 'Bearer',
      expires_in: Math.round(remainingSeconds),
      refresh_token: cli.refresh_token,
      scope: cli.scope,
      obtained_at: now - ((7200 - remainingSeconds) * 1000), // 反推获取时间
    };
  }

  /**
   * 内部格式 → feishu-cli 格式
   *
   * scope 优先级：token.scope > this.requestedScope > ''
   */
  private toCliFormat(token: TokenData): CliTokenFile {
    const expiresAt = new Date(token.obtained_at + token.expires_in * 1000);
    // refresh_token 通常有效期 7 天（604800秒）
    const refreshExpiresAt = new Date(token.obtained_at + 604800 * 1000);

    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? '',
      token_type: token.token_type,
      expires_at: expiresAt.toISOString(),
      refresh_expires_at: refreshExpiresAt.toISOString(),
      scope: token.scope || this.requestedScope || '',
    };
  }

  // ==================== Token 有效性检查 ====================

  private isTokenExpired(token: TokenData): boolean {
    const elapsed = (Date.now() - token.obtained_at) / 1000;
    return elapsed >= (token.expires_in - this.refreshBufferSeconds);
  }

  /**
   * 获取有效的 user_access_token
   * 优先使用缓存，过期则自动刷新，无 token 则返回 null（需要发起设备授权流程）
   */
  async getValidAccessToken(): Promise<string | null> {
    if (!this.cachedToken) {
      return null;
    }

    if (!this.isTokenExpired(this.cachedToken)) {
      return this.cachedToken.access_token;
    }

    if (this.cachedToken.refresh_token) {
      try {
        console.log('[DeviceAuth] access_token 已过期，尝试刷新...');
        const newToken = await this.refreshAccessToken(this.cachedToken.refresh_token);
        this.cachedToken = newToken;
        this.saveTokenToFile(newToken);
        console.log('[DeviceAuth] token 刷新成功');
        return newToken.access_token;
      } catch (err) {
        console.warn('[DeviceAuth] token 刷新失败，需要重新授权:', err);
        this.cachedToken = null;
        return null;
      }
    }

    console.warn('[DeviceAuth] token 过期且无 refresh_token，需要重新授权');
    this.cachedToken = null;
    return null;
  }

  /**
   * 检查是否已有有效的用户授权
   */
  hasValidToken(): boolean {
    return this.cachedToken !== null && !this.isTokenExpired(this.cachedToken);
  }

  // ==================== Step 1: 设备授权请求 ====================

  async requestDeviceAuthorization(scope: string = 'offline_access'): Promise<DeviceAuthResponse> {
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
        const token: TokenData = {
          access_token: data.access_token,
          token_type: data.token_type ?? 'Bearer',
          expires_in: data.expires_in,
          refresh_token: data.refresh_token,
          // 优先用服务器返回的 scope，为空则用请求时的 scope
          scope: data.scope || this.requestedScope,
          obtained_at: Date.now(),
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

    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'Bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      // 刷新后服务器可能不回传 scope，保留已有的
      scope: data.scope || this.requestedScope || this.cachedToken?.scope,
      obtained_at: Date.now(),
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

  // ==================== 辅助方法 ====================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
