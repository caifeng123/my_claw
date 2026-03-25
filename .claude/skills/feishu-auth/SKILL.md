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
  - data/temp/feishu-user-token.json 不存在或内容为空
  - getValidAccessToken() 返回 null
  - 搜索、消息、群聊等命令报权限错误
  - 任何飞书相关操作因身份认证失败而无法继续时

  即使用户没有明确提到"授权"，只要飞书操作因权限问题失败，就应该触发此 skill。
---

# 飞书设备码授权

## 工作原理

项目使用 OAuth 2.0 Device Authorization Grant (RFC 8628) 获取 User Access Token。
用户只需扫码即可完成授权，无需复制回调 URL。

- Token 保存在 `data/temp/feishu-user-token.json`
- 项目服务运行时心跳自动续期（每 24h 刷新），token 不会过期
- **此 skill 只负责首次登录和 token 彻底失效后的重新授权**

## 使用 User Token 调用 feishu-cli

需要 User Token 的 feishu-cli 命令，**统一使用 `pnpm feishu` 代替 `feishu-cli`**：

```bash
# ❌ 旧方式
feishu-cli search docs --query "xxx"

# ✅ 新方式：自动注入 User Token
cd my_claw && pnpm feishu search docs --query "xxx"
```

`pnpm feishu` 是 `feishu-cli` 的 wrapper（`scripts/feishu-cli-wrapper.sh`），自动从 `data/temp/feishu-user-token.json` 读取 `access_token` 并通过环境变量 `FEISHU_USER_ACCESS_TOKEN` 注入，**命令参数和 feishu-cli 完全一致**。

- token 文件不存在时：环境变量为空，feishu-cli 回退到 App Token
- token 过期时：feishu-cli 会报权限错误，按下方流程重新授权即可

**不需要 User Token 的命令**（如 `perm add`、`msg send` 等纯 App Token 操作）直接用 `feishu-cli` 即可。

## 授权流程

所有命令在 `my_claw` 项目根目录执行。

### Step 1：检查 token 状态

```bash
cd my_claw && pnpm auth:check
```

输出 JSON，根据 `status` 判断下一步：

| status | 含义 | 下一步 |
|--------|------|--------|
| `valid` | token 有效 | 无需操作，直接继续飞书操作 |
| `access_expired_refresh_valid` | access_token 过期但 refresh_token 有效 | 服务启动后会自动刷新，一般无需重新授权 |
| `expired` | 全部过期 | 进入 Step 2 |
| `missing` | token 不存在 | 进入 Step 2 |

如果是 `valid` 或 `access_expired_refresh_valid`，**跳过 Step 2，直接继续之前的操作**。

### Step 2：执行授权

```bash
cd my_claw && pnpm auth:login:force
```

> timeout 设为 **600 秒以上**，脚本会轮询等待用户扫码（最长 1800 秒）。

脚本会打印授权链接和 User Code，**必须展示给用户**：

> 请在浏览器中打开以下链接完成飞书授权：
> {输出中的授权链接}
>
> User Code: {输出中的 User Code}

用户扫码完成后脚本自动继续，输出"🎉 授权成功"即表示完成。
然后**继续之前失败的飞书操作**。

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| 缺少 .env 配置 | `FEISHU_APP_ID` 或 `FEISHU_APP_SECRET` 未设置 | 检查 `my_claw/.env` |
| 授权超时 | 用户没在有效期内扫码 | 重新执行 Step 2 |
| `error=20027` | 开发者后台未启用对应权限 | 在飞书开放平台启用权限后重试 |
| `invalid_grant` | refresh_token 已失效 | 执行 Step 2 重新授权 |

## Token 生命周期

- **access_token**：2 小时有效，服务运行时自动刷新（提前 5 分钟）
- **refresh_token**：30 天有效，心跳每 24h 自动续期
- **只要服务在运行，token 永久有效**
- 唯一需要重新扫码：服务停了超过 30 天

## Scope 覆盖

授权自动申请全部已审批 scope（含 `offline_access`），覆盖：
文档创建/读取/编辑、云空间搜索、知识库只读、日历读写、消息/群聊读取、文档/消息搜索、任务读写、通讯录基本信息。

完整列表维护在 `src/config/feishu-scopes.ts`。
