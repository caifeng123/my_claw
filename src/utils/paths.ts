/**
 * 统一文件存储路径管理
 *
 * 所有 session 相关数据统一存放在 data/sessions/{sessionId}/ 下：
 * - history.jsonl   — 对话历史（JSONL 格式）
 * - summary.json    — 压缩摘要缓存
 * - images.json     — 图片分析缓存
 * - files/          — 用户发送 & Bot 生成的文件
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/** 项目根目录 */
const PROJECT_ROOT = process.cwd();

/** sessions 根目录 */
export const SESSIONS_ROOT = join(PROJECT_ROOT, 'data', 'sessions');

// ==================== Session 目录 ====================

/**
 * 获取 session 根目录
 * data/sessions/{sessionId}/
 */
export function getSessionDir(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId);
  const dir = join(SESSIONS_ROOT, safeId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ==================== 对话历史 & 缓存 ====================

/**
 * 获取对话历史文件路径
 * data/sessions/{sessionId}/history.jsonl
 */
export function getHistoryPath(sessionId: string): string {
  const dir = getSessionDir(sessionId);
  return join(dir, 'history.jsonl');
}

/**
 * 获取压缩摘要缓存路径
 * data/sessions/{sessionId}/summary.json
 */
export function getSummaryPath(sessionId: string): string {
  const dir = getSessionDir(sessionId);
  return join(dir, 'summary.json');
}

/**
 * 获取图片分析缓存路径
 * data/sessions/{sessionId}/images.json
 */
export function getImageCachePath(sessionId: string): string {
  const dir = getSessionDir(sessionId);
  return join(dir, 'images.json');
}

// ==================== 文件存储 ====================

/**
 * 获取文件存储目录
 * data/sessions/{sessionId}/files/
 */
export function getFilesDir(sessionId: string): string {
  const dir = join(getSessionDir(sessionId), 'files');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ==================== 工具函数 ====================

/**
 * 安全化 session ID（去除特殊字符）
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_\-:]/g, '_');
}

/**
 * 列出所有 session ID（扫描 sessions 目录下的子目录）
 */
export function listAllSessionIds(): string[] {
  if (!existsSync(SESSIONS_ROOT)) return [];
  const { readdirSync, statSync } = require('fs');
  return readdirSync(SESSIONS_ROOT).filter((name: string) => {
    try {
      return statSync(join(SESSIONS_ROOT, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
