/**
 * 飞书 OAuth scope 集中配置
 *
 * 基于应用在开发者后台实际审批通过的 user 权限。
 * 新增权限时：先在开发者后台申请审批，再在对应分组里加一行。
 *
 * 最后更新：2026-03-25，与开发者后台 user scope 完全一致。
 */

export const FEISHU_SCOPES = {
  // 基础
  base: [
    'offline_access',
  ],

  // 日历
  calendar: [
    'calendar:calendar:read',
    'calendar:calendar.event:read',
    'calendar:calendar.event:create',
    'calendar:calendar.event:update',
    'calendar:calendar.event:reply',
    'calendar:calendar.free_busy:read',
  ],

  // 通讯录
  contact: [
    'contact:user.base:readonly',
    'contact:user.employee_id:readonly',
  ],

  // 文档
  docs: [
    'docx:document:create',
    'docx:document:write_only',
  ],

  // 云文档
  drive: [
    'drive:drive.metadata:readonly',
    'drive:drive.search:readonly',
  ],

  // 消息 & 群
  im: [
    'im:message:readonly',
    'im:message.group_msg:get_as_user',
    'im:chat:read',
    'im:chat.members:read',
  ],

  // 搜索
  search: [
    'search:docs:read',
    'search:message',
  ],

  // 任务
  task: [
    'task:task:read',
    'task:task:write',
    'task:tasklist:read',
    'task:tasklist:write',
  ],

  // 知识库
  wiki: [
    'wiki:wiki:readonly',
  ],
};

/**
 * 获取所有 scope（空格分隔）
 */
export function getAllScopes(): string {
  return Object.values(FEISHU_SCOPES).flat().join(' ');
}

/**
 * 按分组选择 scope
 * @example getScopesByGroups('base', 'drive', 'wiki')
 */
export function getScopesByGroups(...groups: (keyof typeof FEISHU_SCOPES)[]): string {
  return groups.flatMap(g => FEISHU_SCOPES[g]).join(' ');
}
