/**
 * 统一文件存储路径管理
 *
 * 所有 session 相关的文件统一存放在 data/sessions/{sessionId}/files/ 下：
 * - received/  — 用户发送的图片、文件
 * - generated/ — Bot 生成的文件（待发送给用户）
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/** 项目根目录 */
const PROJECT_ROOT = process.cwd();

/** sessions 根目录 */
export const SESSIONS_ROOT = join(PROJECT_ROOT, 'data', 'sessions');

/**
 * 获取用户发送文件的存储目录
 * data/sessions/{sessionId}/files/received/
 */
export function getReceivedFilesDir(sessionId: string): string {
  const dir = join(SESSIONS_ROOT, sessionId, 'files', 'received');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取 Bot 生成文件的存储目录
 * data/sessions/{sessionId}/files/generated/
 */
export function getGeneratedFilesDir(sessionId: string): string {
  const dir = join(SESSIONS_ROOT, sessionId, 'files', 'generated');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取 session 根目录
 * data/sessions/{sessionId}/
 */
export function getSessionDir(sessionId: string): string {
  const dir = join(SESSIONS_ROOT, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
