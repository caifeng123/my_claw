import fs from 'fs';
import path from 'path';

async function uploadFile({
  filePath,
  dir,
  region,
  email,
  filename = `${Date.now() / 1000 | 0}_${path.basename(filePath)}`,
  contentType
}) {
  const url = 'https://ife.bytedance.net/cdn/upload';

  const formData = new FormData();

  formData.append('dir', dir);
  formData.append('region', region);
  formData.append('email', email);

  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });

  formData.append('file', blob, filename);

  const response = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return result.cdnUrl;
}

// 用法示例
uploadFile({
  filePath: process.argv[2],
  dir: 'test',
  region: 'CN',
  email: 'caifeng.nice@bytedance.com'
}).then(res => {
  console.log('上传结果:', res);
}).catch(err => {
  console.error('上传失败:', err);
});