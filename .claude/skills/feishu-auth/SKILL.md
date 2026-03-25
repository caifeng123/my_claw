---
name: feishu-auth
description: |
  飞书设备码授权（OAuth 2.0 Device Flow）。当飞书 API 调用失败并出现权限相关错误时自动触发授权流程，
  也可由用户主动调用。

  **触发场景（务必在以下情况使用此 skill）：**
  - 飞书 API 返回 401、403、permission denied、token 过期、invalid_grant、token expired
  - 飞书错误码：99991663、99991668、99991679（Unauthorized）、20027（scope 未启用）
  - 用户说"飞书授权"、"飞书登录"、"重新授权"、"token 过期了"、"权限不够"、
    "认证"、"获取 Token"、"OAuth 授权"、"auth login"、"刷新 Token"
  - ~/.feishu-cli/token.json 不存在或内容为空
  - getValidAccessToken() 返回 null
  - 搜索、消息、群聊等命令报权限错误
  - 任何飞书相关操作因身份认证失败而无法继续时
  - 其他飞书功能遇到 User Access Token 相关问题时

  即使用户没有明确提到"授权"，只要飞书操作因权限问题失败，就应该触发此 skill。
---

# 飞书设备码授权

## 工作原理

项目使用 OAuth 2.0 Device Authorization Grant (RFC 8628) 获取 User Access Token。
相比传统 Authorization Code Flow，Device Flow 对 AI Agent 更友好——用户只需扫码，无需复制回调 URL。

Token 保存在 `~/.feishu-cli/token.json`，格式兼容 feishu-cli。

## 执行步骤

### 1. 运行授权脚本

在 `my_claw` 项目目录下执行：

```bash
cd my_claw && npx tsx scripts/device-auth-login.ts --force
```

**重要**：
- timeout 必须设为 **600 秒以上**，因为脚本会轮询等待用户扫码（最长 1800 秒）
- `--force` 强制重新授权（即使当前 token 仍有效）
- 脚本依赖 `.env` 文件中的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`

### 2. 从输出中提取授权链接

脚本会打印类似这样的内容：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 请在浏览器中打开以下链接完成授权：

   https://open.feishu.cn/open-apis/authen/v1/authorize?...

📝 User Code: ABCD-1234
⏰ 有效期: 1800 秒
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏳ 等待授权中（完成扫码后自动继续）...
```

**必须将授权链接和 User Code 展示给用户**，告诉他们：
> 请在浏览器中打开上面的链接，完成飞书扫码授权。授权完成后脚本会自动继续。

### 3. 等待授权完成

脚本会在后台轮询。授权成功后输出：

```
🎉 授权成功！Token 已保存到 ~/.feishu-cli/token.json
```

看到这个就说明授权成功，可以**继续之前失败的飞书操作**。

### 4. 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| 缺少 .env 配置 | `FEISHU_APP_ID` 或 `FEISHU_APP_SECRET` 未设置 | 检查 `my_claw/.env` |
| 授权超时 | 用户没在有效期内扫码 | 重新运行脚本 |
| `error=20027` | 开发者后台未启用对应权限 | 在飞书开放平台启用权限后重试 |
| `invalid_grant` | refresh_token 已失效 | 加 `--force` 重新授权 |

## Token 生命周期

授权完成后，token 管理完全自动：

- **access_token**：2 小时有效，API 调用时自动刷新（提前 5 分钟 buffer）
- **refresh_token**：30 天有效，心跳每 24h 自动续期
- **只要服务在运行，token 永久有效**，不需要反复授权
- 唯一需要重新扫码的情况：服务停了超过 30 天

## Scope 覆盖范围

授权时自动申请全部 24 个已审批 scope（含 `offline_access`），覆盖：

| 类别 | 能力 |
|------|------|
| 文档 | 创建、读取、编辑云文档 |
| 云空间 | 文件元数据读取、搜索 |
| 知识库 | Wiki 只读访问 |
| 日历 | 日程读取、创建、更新、回复、忙闲查询 |
| 消息 | 消息只读、群消息读取、群聊信息 |
| 搜索 | 文档搜索、消息搜索 |
| 任务 | 任务和任务列表的读写 |
| 通讯录 | 用户基本信息、工号读取 |
