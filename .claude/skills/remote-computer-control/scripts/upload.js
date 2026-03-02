#!/usr/bin/env node

/**
  * 图片上传工具 - 上传图片到 CDN
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// ==================== 配置 ====================
const CDN_UPLOAD_URL = 'https://ife.bytedance.net/cdn/upload';
const CDN_CONFIG = {
  dir: 'test',
  region: 'CN',
  email: 'caifeng.nice@bytedance.com',
};

// ==================== CDN 上传 ====================
export async function uploadImage(filePath) {
  const filename = `${Date.now() / 1000 | 0}_${basename(filePath)}`;
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
    throw new Error(`上传失败 [${response.status}]: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.cdnUrl) {
    throw new Error(`CDN 未返回 URL: ${JSON.stringify(result)}`);
  }

  return result.cdnUrl;
}


// ==================== CLI 直接调用 ====================
if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('用法: node upload.mjs <图片路径>');
    process.exit(1);
  }
  uploadImage(filePath)
    .then((url) => console.log('上传结果:', url))
    .catch((err) => console.error('上传失败:', err.message));
}