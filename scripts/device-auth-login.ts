#!/usr/bin/env npx tsx
/**
 * 飞书设备码授权脚本（首次授权 / token 过期后重新授权）
 *
 * 用法：
 *   npx tsx scripts/device-auth-login.ts
 *
 * 流程：
 *   1. 读取 .env 中的 FEISHU_APP_ID / FEISHU_APP_SECRET
 *   2. 发起设备码授权请求
 *   3. 打印授权链接和 user_code
 *   4. 轮询等待用户在浏览器中完成扫码授权
 *   5. 获取 token 并保存到 ~/.feishu-cli/token.json
 *
 * 之后服务会自动加载 token，心跳保活，无需再次运行此脚本。
 */

import 'dotenv/config';
import { DeviceAuthClient } from '../src/services/feishu/device-auth.js';
import { getAllScopes } from '../src/config/feishu-scopes.js';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error('❌ 请在 .env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  process.exit(1);
}

async function main() {
  const client = new DeviceAuthClient({
    appId: appId!,
    appSecret: appSecret!,
    platform: 'feishu',
  });

  // 先检查是否已有有效 token
  const existing = await client.getValidAccessToken();
  if (existing) {
    const status = client.getTokenStatus();
    console.log('✅ 当前已有有效 token，无需重新授权');
    console.log(`   access 有效至: ${status.accessExpiresAt}`);
    console.log(`   refresh 有效至: ${status.refreshExpiresAt}`);

    const forceReauth = process.argv.includes('--force');
    if (!forceReauth) {
      console.log('\n   如需强制重新授权，请加 --force 参数');
      return;
    }
    console.log('\n⚠️  --force 模式，将重新授权...\n');
  }

  // 发起设备码授权
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
  console.log('\n⏳ 等待授权中（完成扫码后自动继续）...\n');

  // 轮询等待
  await client.pollForToken(auth.device_code, auth.interval, auth.expires_in);

  const status = client.getTokenStatus();
  console.log('\n🎉 授权成功！Token 已保存到 ~/.feishu-cli/token.json');
  console.log(`   access 有效至: ${status.accessExpiresAt}`);
  console.log(`   refresh 有效至: ${status.refreshExpiresAt}`);
  console.log('\n   服务启动后会自动加载 token，心跳每 24h 刷新一次。');
}

main().catch(err => {
  console.error('❌ 授权失败:', err.message || err);
  process.exit(1);
});
