#!/usr/bin/env npx tsx
/**
 * 后台轮询脚本 — 由 device-auth-login.ts start 子命令 spawn 调用
 *
 * 参数：device_code interval expires_in
 * 功能：后台轮询飞书 token 接口，扫码成功后自动写入 token 文件
 */

import 'dotenv/config';
import { DeviceAuthClient } from '../src/services/feishu/device-auth.js';

const [deviceCode, intervalStr, expiresInStr] = process.argv.slice(2);

if (!deviceCode || !intervalStr || !expiresInStr) {
  process.exit(1);
}

const appId = process.env.FEISHU_APP_ID!;
const appSecret = process.env.FEISHU_APP_SECRET!;

const client = new DeviceAuthClient({ appId, appSecret, platform: 'feishu' });

try {
  await client.pollForToken(deviceCode, Number(intervalStr), Number(expiresInStr));
  // token 已由 pollForToken 内部写入文件，静默退出
} catch {
  // 后台进程，无处输出，静默退出
}
process.exit(0);
