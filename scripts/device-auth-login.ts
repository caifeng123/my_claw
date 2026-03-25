#!/usr/bin/env npx tsx
/**
 * 飞书设备码授权 CLI
 *
 * 用法：
 *   npx tsx scripts/device-auth-login.ts check    — 检查 token 状态（JSON 输出）
 *   npx tsx scripts/device-auth-login.ts [login]   — 执行授权流程
 *   npx tsx scripts/device-auth-login.ts --force    — 强制重新授权
 *
 * Token 保存在 data/temp/feishu-user-token.json，
 * 服务启动后心跳自动续期，无需反复授权。
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

const subcommand = process.argv[2] || 'login';

// ==================== check 子命令 ====================

if (subcommand === 'check') {
  const client = new DeviceAuthClient({ appId, appSecret, platform: 'feishu' });
  const status = client.getTokenStatus();

  if (!status.hasToken) {
    console.log(JSON.stringify({ status: 'missing' }));
  } else if (status.accessTokenValid) {
    console.log(JSON.stringify({
      status: 'valid',
      accessExpiresAt: status.accessExpiresAt,
      refreshExpiresAt: status.refreshExpiresAt,
    }));
  } else if (status.refreshTokenValid) {
    console.log(JSON.stringify({
      status: 'access_expired_refresh_valid',
      reason: 'access_token 已过期，refresh_token 有效。服务启动后会自动刷新。',
      refreshExpiresAt: status.refreshExpiresAt,
    }));
  } else {
    console.log(JSON.stringify({
      status: 'expired',
      reason: 'access_token 和 refresh_token 均已过期，需要重新授权',
    }));
  }
  process.exit(0);
}

// ==================== login 子命令（默认） ====================

async function main() {
  const client = new DeviceAuthClient({ appId: appId!, appSecret: appSecret!, platform: 'feishu' });

  // 检查现有 token
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
  console.log('\n🎉 授权成功！Token 已保存到 data/temp/feishu-user-token.json');
  console.log(`   access 有效至: ${status.accessExpiresAt}`);
  console.log(`   refresh 有效至: ${status.refreshExpiresAt}`);
  console.log('\n   服务启动后会自动加载 token，心跳自动续期。');
}

main().catch(err => {
  console.error('❌ 授权失败:', err.message || err);
  process.exit(1);
});
