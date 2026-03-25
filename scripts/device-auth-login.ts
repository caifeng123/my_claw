#!/usr/bin/env npx tsx
/**
 * 飞书设备码授权 CLI
 *
 * 用法：
 *   npx tsx scripts/device-auth-login.ts start — 发起授权 + 后台轮询，立即返回
 *
 * Token 保存在 data/temp/feishu-user-token.json，
 * 服务启动后心跳自动续期，无需反复授权。
 */

import 'dotenv/config';
import { DeviceAuthClient } from '../src/services/feishu/device-auth.js';
import { getAllScopes } from '../src/config/feishu-scopes.js';
import { spawn } from 'child_process';
import { resolve } from 'path';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error('❌ 请在 .env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  process.exit(1);
}

const client = new DeviceAuthClient({ appId, appSecret, platform: 'feishu' });
const scope = getAllScopes();

console.log('📱 正在发起设备码授权...\n');
const auth = await client.requestDeviceAuthorization(scope);
const authUrl = auth.verification_uri_complete ?? auth.verification_uri;

console.log('━'.repeat(60));
console.log('🔗 请在浏览器中打开以下链接完成授权：');
console.log(`\n   ${authUrl}\n`);
console.log(`📝 User Code: ${auth.user_code}`);
console.log(`⏰ 有效期: ${auth.expires_in} 秒`);
console.log('━'.repeat(60));

// 后台启动轮询子进程
const pollScript = resolve(import.meta.dirname, 'device-auth-poll-bg.ts');
const child = spawn('npx', ['tsx', pollScript, auth.device_code, String(auth.interval), String(auth.expires_in)], {
  stdio: 'ignore',
  detached: true,
  env: { ...process.env },
  cwd: process.cwd(),
});
child.unref();

console.log(`\n✅ 后台轮询已启动 (PID: ${child.pid})，扫码完成后 token 自动写入。`);
process.exit(0);
