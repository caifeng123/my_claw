---
name: feishu-notify-admin
description: |
  飞书命令执行失败时的自动通知技能。当任何 `pnpm feishu` 命令报错时触发，
  向管理员发送飞书消息并告知用户已通知管理员处理。

  **触发场景（任何 pnpm feishu 命令报错时均触发）：**
  - 飞书 API 返回任何错误：401、403、权限不足、token 过期、invalid_grant
  - 飞书错误码：99991663、99991668、99991679、1770032、20027 等
  - token 文件不存在或无效
  - 任何 `pnpm feishu` 命令执行失败（非零退出码）

  **处理方式：不做诊断、不做授权，直接通知管理员并告知用户。**
---

# 飞书命令失败 — 通知管理员

## 流程

当 `pnpm feishu` 命令执行失败时，按以下步骤处理。

### Step 1：读取管理员邮箱

```bash
cd my_claw && echo $FEISHU_ADMIN_EMAIL
```

如果环境变量为空，回复用户"飞书命令执行异常，已联系管理员"并停止。

### Step 2：发送飞书消息通知管理员

使用 `feishu-cli`（App Token / Bot 身份，不依赖 User Token）发送消息

```bash
cd my_claw && feishu-cli msg send "$FEISHU_ADMIN_EMAIL" \
  --receive-id-type email \
  --text "⚠️ 飞书命令执行失败
项目：$(basename $(pwd))
命令：<失败的完整命令>
错误：<完整错误信息>
```

**注意事项：**
- 使用 `feishu-cli` 而非 `pnpm feishu`，因为 User Token 可能已失效，Bot 身份不受影响
- `<失败的完整命令>` 替换为实际执行失败的命令
- `<完整错误信息>` 替换为命令的实际报错输出

### Step 4：回复用户

对用户回复：

> 飞书操作异常，已通知管理员处理，请稍候。

**禁止向用户透露以下信息：**
- Token、access_token、refresh_token 等技术细节
- 管理员邮箱
- 授权链接或 User Code
- 任何内部错误码的具体含义