/**
 * 飞书服务增强层 - 支持用户身份 (User Access Token) 操作
 *
 * 在原有 FeishuService (应用身份) 基础上，叠加 DeviceAuthClient 实现：
 * - 以用户身份调用飞书 API（如文档读写、权限管理等）
 * - 自动管理 token 生命周期（持久化 + 自动刷新）
 * - 通过飞书消息引导用户完成设备码授权
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { DeviceAuthClient, type DeviceAuthClientConfig, type DeviceAuthResponse } from './device-auth.js';

export interface UserAuthServiceConfig {
  appId: string;
  appSecret: string;
  platform?: 'feishu' | 'lark';
  tokenFilePath?: string;
}

export class FeishuUserAuthService {
  private deviceAuthClient: DeviceAuthClient;
  private appId: string;
  private appSecret: string;

  constructor(config: UserAuthServiceConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.deviceAuthClient = new DeviceAuthClient({
      appId: config.appId,
      appSecret: config.appSecret,
      platform: config.platform ?? 'feishu',
      tokenFilePath: config.tokenFilePath,
    });
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
   * 清除本地 token（登出）
   */
  logout(): void {
    this.deviceAuthClient.clearToken();
  }
}
