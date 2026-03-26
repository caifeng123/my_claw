/**
 * 飞书服务增强层 - 支持用户身份 (User Access Token) 操作
 *
 * 在原有 FeishuService (应用身份) 基础上，叠加 DeviceAuthClient 实现：
 * - 以用户身份调用飞书 API（如文档读写、权限管理等）
 * - 自动管理 token 生命周期（持久化 + 按需刷新）
 * - 通过飞书消息引导用户完成设备码授权
 * - 心跳保活：启动时强制刷新 + 每小时定时刷新，确保 token 始终有效
 */

import { DeviceAuthClient, type DeviceAuthResponse } from './device-auth.js';

export interface UserAuthServiceConfig {
  appId: string;
  appSecret: string;
  platform?: 'feishu' | 'lark';
  tokenFilePath?: string;
  /** 心跳间隔（毫秒），默认 1 小时。设为 0 禁用心跳 */
  heartbeatIntervalMs?: number;
}

/** 默认心跳间隔：1 小时 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1 * 60 * 60 * 1000;

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

    if (this.heartbeatIntervalMs > 0) {
      this.startHeartbeat();
    }
  }

  // ==================== 心跳保活 ====================

  /**
   * 启动时无条件强制刷新一次，拿到完整有效期的 token；
   * 之后每小时再强制刷新一次，确保 token 始终有效。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    const doRefresh = async () => {
      const status = this.deviceAuthClient.getTokenStatus();
      if (!status.hasToken) return;

      try {
        // 无条件强制刷新，不管 access_token 是否过期
        await this.deviceAuthClient.forceRefresh();
      } catch (err) {
        console.error('[UserAuth] 心跳刷新 token 异常:', err);
      }
    };

    // 启动时立即强制刷新，确保 token 从一开始就是满有效期的
    doRefresh();

    this.heartbeatTimer = setInterval(doRefresh, this.heartbeatIntervalMs);

    // 不阻止 Node.js 进程退出
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
   * 清除本地 token（登出），同时停止心跳
   */
  logout(): void {
    this.stopHeartbeat();
    this.deviceAuthClient.clearToken();
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
