/**
 * 飞书服务增强层 - 支持用户身份 (User Access Token) 操作
 *
 * 在原有 FeishuService (应用身份) 基础上，叠加 DeviceAuthClient 实现：
 * - 以用户身份调用飞书 API（如文档读写、权限管理等）
 * - 自动管理 token 生命周期（持久化 + 自动刷新）
 * - 通过飞书消息引导用户完成设备码授权
 * - **心跳机制**：每天自动触发一次 token 检查 & 刷新，确保 token 常热
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { DeviceAuthClient, type DeviceAuthClientConfig, type DeviceAuthResponse } from './device-auth.js';
import { getAllScopes } from '../../config/feishu-scopes.js';

export interface UserAuthServiceConfig {
  appId: string;
  appSecret: string;
  platform?: 'feishu' | 'lark';
  tokenFilePath?: string;
  /** 心跳间隔（毫秒），默认 24 小时。设为 0 禁用心跳 */
  heartbeatIntervalMs?: number;
}

/** 默认心跳间隔：24 小时 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class FeishuUserAuthService {
  private deviceAuthClient: DeviceAuthClient;
  private appId: string;
  private appSecret: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;

  constructor(config: UserAuthServiceConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.deviceAuthClient = new DeviceAuthClient({
      appId: config.appId,
      appSecret: config.appSecret,
      platform: config.platform ?? 'feishu',
      tokenFilePath: config.tokenFilePath,
    });

    // 自动启动心跳
    if (this.heartbeatIntervalMs > 0) {
      this.startHeartbeat();
    }
  }

  // ==================== 心跳机制 ====================

  /**
   * 启动心跳定时器
   * - 每 heartbeatIntervalMs（默认 24h）自动调用 getAccessToken()
   * - getAccessToken() 内部会检查过期并自动 refresh
   * - 这确保即使没有用户主动请求，token 也不会静默过期
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return; // 已在运行

    console.log(`[UserAuth] 💓 心跳已启动，间隔 ${Math.round(this.heartbeatIntervalMs / 3600000)}h`);

    this.heartbeatTimer = setInterval(async () => {
      try {
        const statusBefore = this.deviceAuthClient.getTokenStatus();
        if (!statusBefore.hasToken) {
          console.log('[UserAuth] 💓 心跳：无 token，跳过');
          return;
        }

        console.log(`[UserAuth] 💓 心跳触发 token 检查...`);
        const token = await this.deviceAuthClient.getValidAccessToken();

        const statusAfter = this.deviceAuthClient.getTokenStatus();
        if (token) {
          console.log(
            `[UserAuth] 💓 心跳完成：token 有效` +
            `，access 过期时间 ${statusAfter.accessExpiresAt}` +
            `，refresh 过期时间 ${statusAfter.refreshExpiresAt}`
          );
        } else {
          console.warn('[UserAuth] 💓 心跳：token 已完全失效，需要重新授权');
        }
      } catch (err) {
        console.error('[UserAuth] 💓 心跳异常:', err);
      }
    }, this.heartbeatIntervalMs);

    // 不阻止 Node.js 进程退出
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * 停止心跳定时器
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[UserAuth] 💓 心跳已停止');
    }
  }

  // ==================== 授权状态 ====================

  /**
   * 是否已有有效的用户 token
   */
  isAuthorized(): boolean {
    return this.deviceAuthClient.hasValidToken();
  }

  /**
   * 获取有效的 user_access_token，过期自动刷新
   * 返回 null 表示需要重新授权
   */
  async getAccessToken(): Promise<string | null> {
    return this.deviceAuthClient.getValidAccessToken();
  }

  /**
   * 获取当前 token 状态摘要
   */
  getTokenStatus() {
    return this.deviceAuthClient.getTokenStatus();
  }

  // ==================== 设备码授权流程 ====================

  /**
   * 发起设备码授权，返回授权信息（授权链接、user_code 等）
   * 调用方负责将授权链接展示给用户（如发送飞书消息）
   */
  async startDeviceAuth(scope: string = 'offline_access'): Promise<DeviceAuthResponse> {
    return this.deviceAuthClient.requestDeviceAuthorization(scope);
  }

  /**
   * 轮询等待用户完成授权
   * 建议在后台执行，授权成功后 token 自动持久化
   */
  async waitForAuthorization(deviceCode: string, interval: number = 5, timeout: number = 300) {
    return this.deviceAuthClient.pollForToken(deviceCode, interval, timeout);
  }

  /**
   * 一键完成设备授权流程（发起 + 轮询），返回授权链接供展示
   * 注意：此方法会阻塞直到用户授权完成或超时
   */
  async authorizeWithDeviceFlow(scope: string = 'offline_access'): Promise<{
    authUrl: string;
    userCode: string;
    waitForAuth: () => Promise<void>;
  }> {
    const auth = await this.startDeviceAuth(scope);
    const authUrl = auth.verification_uri_complete ?? auth.verification_uri;

    return {
      authUrl,
      userCode: auth.user_code,
      waitForAuth: async () => {
        await this.waitForAuthorization(auth.device_code, auth.interval);
      },
    };
  }

  // ==================== 以用户身份调用 API ====================

  /**
   * 创建一个带有 user_access_token 的请求头
   * 用于直接调用飞书 Open API
   */
  async getUserAuthHeaders(): Promise<Record<string, string> | null> {
    const token = await this.getAccessToken();
    if (!token) return null;
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  /**
   * 以用户身份发起 GET 请求
   */
  async userGet<T = any>(url: string): Promise<T | null> {
    const headers = await this.getUserAuthHeaders();
    if (!headers) return null;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`User API GET failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as T;
  }

  /**
   * 以用户身份发起 POST 请求
   */
  async userPost<T = any>(url: string, body: any): Promise<T | null> {
    const headers = await this.getUserAuthHeaders();
    if (!headers) return null;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`User API POST failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as T;
  }

  /**
   * 获取当前授权用户的基本信息
   */
  async getCurrentUserInfo(): Promise<any | null> {
    return this.userGet('https://open.feishu.cn/open-apis/authen/v1/user_info');
  }

  /**
   * 清除本地 token（登出），同时停止心跳
   */
  logout(): void {
    this.stopHeartbeat();
    this.deviceAuthClient.clearToken();
  }

  /**
   * 销毁服务，清理定时器（用于优雅退出）
   */
  destroy(): void {
    this.stopHeartbeat();
  }
}


// ==================== 单例管理 ====================

let _instance: FeishuUserAuthService | null = null;

/**
 * 初始化用户授权服务（应用启动时调用一次）
 */
export function initUserAuthService(config: {
  appId: string;
  appSecret: string;
  platform?: 'feishu' | 'lark';
}): FeishuUserAuthService {
  _instance = new FeishuUserAuthService({
    appId: config.appId,
    appSecret: config.appSecret,
    platform: config.platform ?? 'feishu',
  });

  const status = _instance.getTokenStatus();
  if (status.hasToken) {
    console.log(`🔑 用户 token 已加载，access 有效至 ${status.accessExpiresAt}`);
  } else {
    console.warn('🔑 未找到用户 token，请运行: npx tsx scripts/device-auth-login.ts');
  }

  return _instance;
}

/**
 * 获取用户授权服务单例
 */
export function getUserAuthService(): FeishuUserAuthService | null {
  return _instance;
}
