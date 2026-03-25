/**
 * 飞书用户身份授权 - Agent Tools
 *
 * 提供给 Agent 的工具，用于：
 * 1. 检查当前是否已完成用户授权
 * 2. 发起设备码授权流程（生成授权链接）
 * 3. 以用户身份调用飞书 API
 */

import { z } from 'zod';
import type { RegisteredTool } from '../types/tools.js';
import { FeishuUserAuthService } from '../../../services/feishu/user-auth-service.js';
import { getAllScopes } from '../../../config/feishu-scopes.js';

// 单例
let userAuthService: FeishuUserAuthService | null = null;

export function initUserAuthService(config: {
  appId: string;
  appSecret: string;
  platform?: 'feishu' | 'lark';
}): FeishuUserAuthService {
  userAuthService = new FeishuUserAuthService({
    appId: config.appId,
    appSecret: config.appSecret,
    platform: config.platform ?? 'feishu',
  });
  return userAuthService;
}

export function getUserAuthService(): FeishuUserAuthService | null {
  return userAuthService;
}

/**
 * 创建用户授权相关的工具列表
 */
export function createUserAuthTools(): RegisteredTool[] {
  // 1. 检查授权状态
  const checkAuthTool: RegisteredTool = {
    name: 'feishu_check_user_auth',
    description: '检查当前是否已完成飞书用户身份授权。返回授权状态，如已授权则返回用户信息。',
    inputSchema: {},
    execute: async () => {
      if (!userAuthService) {
        return { success: false, output: { authorized: false, error: '用户授权服务未初始化' } };
      }

      const token = await userAuthService.getAccessToken();
      console.log('[CheckAuth] token:', token);
      if (!token) {
        return {
          success: true,
          output: {
            authorized: false,
            message: '未授权或 token 已过期，请使用 feishu_start_device_auth 发起授权',
          },
        };
      }

      try {
        const userInfo = await userAuthService.getCurrentUserInfo();
        return {
          success: true,
          output: { authorized: true, user: userInfo?.data },
        };
      } catch (err) {
        return {
          success: true,
          output: { authorized: true, message: 'token 有效但获取用户信息失败', error: String(err) },
        };
      }
    },
  };

  // 2. 发起设备码授权
  const startAuthTool: RegisteredTool = {
    name: 'feishu_start_device_auth',
    description:
      '发起飞书设备码授权流程。返回授权链接和 user_code，用户需在浏览器中打开链接完成授权。授权成功后自动保存 token，后续飞书 API 操作将以用户身份执行。',
    inputSchema: {
      scope: z.string().optional().describe('授权范围，默认申请所有已配置的权限'),
    },
    execute: async (params: Record<string, any>) => {
      if (!userAuthService) {
        return { success: false, error: '用户授权服务未初始化' };
      }

      try {
        const scope = (params.scope as string) ?? getAllScopes();
        const auth = await userAuthService.startDeviceAuth(scope);
        const authUrl = auth.verification_uri_complete ?? auth.verification_uri;

        // 后台轮询（不阻塞 tool 返回）
        userAuthService
          .waitForAuthorization(auth.device_code, auth.interval, 600)
          .then(() => console.log('[DeviceAuth] ✅ 用户授权成功！'))
          .catch((err) => console.error('[DeviceAuth] ❌ 授权失败:', err));

        return {
          success: true,
          output: {
            auth_url: authUrl,
            user_code: auth.user_code,
            expires_in: auth.expires_in,
            hint: '请在浏览器中打开上方链接完成授权。授权完成后，后续操作将以你的身份执行。',
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  };

  // 3. 用户身份 API 调用
  const userApiTool: RegisteredTool = {
    name: 'feishu_user_api_call',
    description:
      '以当前已授权的用户身份调用飞书 Open API。需先完成 feishu_start_device_auth 授权。支持 GET / POST 方法。',
    inputSchema: {
      method: z.enum(['GET', 'POST']).describe('HTTP 方法'),
      url: z.string().describe('飞书 Open API 完整 URL'),
      body: z.any().optional().describe('POST 请求体（JSON）'),
    },
    execute: async (params: Record<string, any>) => {
      if (!userAuthService) {
        return { success: false, error: '用户授权服务未初始化' };
      }

      try {
        const method = params.method as string;
        const url = params.url as string;

        if (method === 'GET') {
          const result = await userAuthService.userGet(url);
          return { success: true, output: result };
        } else {
          const result = await userAuthService.userPost(url, params.body ?? {});
          return { success: true, output: result };
        }
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  };

  // 4. 登出
  const logoutTool: RegisteredTool = {
    name: 'feishu_user_logout',
    description: '清除本地保存的飞书用户 token，登出用户授权。',
    inputSchema: {},
    execute: async () => {
      if (!userAuthService) {
        return { success: false, error: '用户授权服务未初始化' };
      }
      userAuthService.logout();
      return { success: true, output: { message: '已清除用户授权 token' } };
    },
  };

  return [checkAuthTool, startAuthTool, userApiTool, logoutTool];
}
