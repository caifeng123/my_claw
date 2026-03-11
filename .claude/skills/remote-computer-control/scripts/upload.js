#!/usr/bin/env node

/**
 * CDN 图片上传工具
 *
 * 导出：uploadImage(filePath) → Promise<string>  (CDN URL)
 * CLI：node upload.js <图片路径>
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// ─── 配置 ─────────────────────────────────────────────────

const CDN_UPLOAD_URL = 'https://ife.bytedance.net/cdn/upload';
const CDN_CONFIG = {
  dir: 'test',
  region: 'CN',
  email: 'caifeng.nice@bytedance.com',
};

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ─── 上传实现 ─────────────────────────────────────────────

async function attemptUpload(filePath) {
  const filename = `${(Date.now() / 1000) | 0}_${basename(filePath)}`;
  const buffer = readFileSync(filePath);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });

  const formData = new FormData();
  formData.append('dir', CDN_CONFIG.dir);
  formData.append('region', CDN_CONFIG.region);
  formData.append('email', CDN_CONFIG.email);
  formData.append('file', blob, filename);

  const response = await fetch(CDN_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.cdnUrl) {
    throw new Error(`CDN 未返回 URL: ${JSON.stringify(result)}`);
  }

  return result.cdnUrl;
}

/**
 * 上传图片到 CDN（含自动重试）
 * @param {string} filePath - 本地图片路径
 * @returns {Promise<string>} CDN URL
 */
export async function uploadImage(filePath) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await attemptUpload(filePath);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        console.warn(`   ⚠️  上传失败 (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}，${delay}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`上传失败（已重试 ${MAX_RETRIES} 次）: ${lastError.message}`);
}

// ─── CLI 入口 ─────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('用法: node upload.js <图片路径>');
    process.exit(1);
  }
  uploadImage(filePath)
    .then((url) => console.log(`✅ 上传成功: ${url}`))
    .catch((err) => {
      console.error(`❌ 上传失败: ${err.message}`);
      process.exit(1);
    });
}
