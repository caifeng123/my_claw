/**
 * mention-utils.ts — mentions 解析的纯函数模块
 *
 * 职责：
 *   1. 将飞书原始 mention 数据解析为结构化 MentionInfo[]
 *   2. 将消息文本中的 mention 占位符替换为可读格式
 *   3. 将 MentionInfo[] 序列化为 Agent 系统提示词片段
 *
 * 设计原则：
 *   - 纯函数，无副作用（缓存写入由调用方负责）
 *   - 所有入参有类型约束，出参结构明确
 *   - 便于单元测试
 */

import type { MentionInfo } from './types.js';

// ==================== 飞书原始 mention 类型（兼容多版本 SDK） ====================

/** 飞书事件推送中单个 mention 的原始结构 */
export interface RawMention {
  /** @占位符 key，如 "@_user_1" */
  key?: string;
  /** 被 @ 用户的 open_id — 可能是 string 或 { open_id: string } */
  id?: string | { open_id?: string };
  /** 被 @ 用户的显示名称 */
  name?: string;
}

// ==================== 解析结果 ====================

export interface ParseMentionsResult {
  /** 替换占位符后的消息文本 */
  content: string;
  /** 结构化 mention 列表 */
  mentions: MentionInfo[];
  /** 从 mention 中提取的 openId → name 映射，供调用方写入缓存 */
  identityHints: Map<string, string>;
}

// ==================== 核心函数 ====================

/**
 * 解析飞书原始 mentions，返回替换后的文本 + 结构化数组 + 身份提示
 *
 * @param content   - 消息原始文本（含占位符）
 * @param rawMentions - 飞书事件中的 mentions 数组
 * @param botOpenId - 当前 bot 的 open_id，用于标记 isSelf
 */
export function parseMentions(
  content: string,
  rawMentions: RawMention[] | undefined | null,
  botOpenId?: string,
): ParseMentionsResult {
  const mentions: MentionInfo[] = [];
  const identityHints = new Map<string, string>();

  if (!rawMentions || !Array.isArray(rawMentions) || rawMentions.length === 0) {
    return { content, mentions, identityHints };
  }

  let replaced = content;

  for (const raw of rawMentions) {
    const openId = extractOpenId(raw.id);
    const name = raw.name || '未知用户';
    const isSelf = !!(botOpenId && openId === botOpenId);

    // 构建结构化 MentionInfo
    if (openId) {
      mentions.push({ userId: openId, name, isSelf });
      if (name && name !== '未知用户') {
        identityHints.set(openId, name);
      }
    }

    // 文本替换：用 replaceAll 避免同一 key 只替换第一个的 bug
    if (raw.key) {
      const readable = openId ? `@${name}(${openId})` : `@${name}`;
      replaced = replaced.replaceAll(raw.key, readable);
    }
  }

  // 清理多余空格
  replaced = replaced.replace(/\s+/g, ' ').trim();

  return { content: replaced, mentions, identityHints };
}

/**
 * 将 MentionInfo[] 格式化为 Agent 系统提示词片段
 *
 * @returns 提示词字符串，若无 mentions 则返回空字符串
 */
export function formatMentionsForPrompt(mentions: MentionInfo[] | undefined): string {
  if (!mentions || mentions.length === 0) {
    return '';
  }

  const descriptions = mentions
    .map(m => m.isSelf
      ? `@${m.name ?? '未知'}(${m.userId}) [这是你自己]`
      : `@${m.name ?? '未知'}(${m.userId})`)
    .join(', ');

  return `[本次消息的 @提及] ${descriptions}`;
}

/**
 * 检查原始 mentions 中是否包含指定 botOpenId
 */
export function isBotMentioned(
  rawMentions: RawMention[] | undefined | null,
  botOpenId: string | undefined,
): boolean {
  if (!rawMentions || !Array.isArray(rawMentions) || rawMentions.length === 0) {
    return false;
  }
  if (!botOpenId) {
    // 降级：botOpenId 未获取到时无法判断，放行
    console.warn('⚠️ botOpenId 未获取到，无法判断群聊消息是否 @机器人，放行处理');
    return true;
  }
  return rawMentions.some(m => extractOpenId(m.id) === botOpenId);
}

// ==================== 内部工具函数 ====================

/** 兼容 string | { open_id?: string } 两种格式 */
function extractOpenId(id: RawMention['id']): string {
  if (typeof id === 'string') return id;
  return id?.open_id || '';
}
