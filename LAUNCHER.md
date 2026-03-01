# Launcher 启动器

Launcher 是一个父进程管理工具，用于替代 `tsx watch` 模式，解决热更新导致的会话丢失问题。

## 特性

- ✅ **无自动热更新** - Claude Code 修改文件不会导致服务重启
- ✅ **手动触发重启** - 用户在飞书发送 `/restart` 指令后服务重启
- ✅ **启动失败自动回滚** - 新代码导致服务无法启动时，自动回滚到旧版本
- ✅ **跨重启状态通知** - 重启完成后主动向用户发送结果通知

## 架构

```
┌─────────────────┐         fork          ┌─────────────────┐
│   launcher.ts   │ ◄──────────────────► │   src/index.ts  │
│   (父进程)       │     IPC 通信          │   (子进程/业务服务)│
└─────────────────┘                      └─────────────────┘
        │                                        │
        │  1. 启动子进程                          │  1. 启动 HTTP 服务
        │  2. 等待 ready 信号                      │  2. 连接飞书 WebSocket
        │  3. 监控子进程退出                       │  3. 发送 ready 信号
        │  4. 异常时执行回滚                        │  4. 处理 /restart 指令
        ▼                                        ▼
   ┌──────────┐                            ┌──────────┐
   │ Git Stash │  (回滚时暂存有问题的代码)    │  飞书用户  │
   └──────────┘                            └──────────┘
```

## 启动流程

### 正常启动

1. `npm run launcher` 启动 launcher（父进程）
2. launcher fork 子进程运行 `src/index.ts`
3. 子进程启动 HTTP 服务和飞书连接
4. 子进程通过 IPC 发送 `ready` 信号给 launcher
5. launcher 确认服务启动成功

### 重启流程

1. 用户在飞书发送 `/restart` 指令
2. 业务服务写入 `.restart-state.json` 状态文件
3. 业务服务回复用户 "正在重启..."
4. 业务服务延迟 1 秒后 `process.exit(0)`
5. launcher 检测到子进程 exit code 0，判断为正常重启
6. launcher 重新 fork 子进程
7. 子进程启动后读取状态文件，向用户发送重启结果通知
8. 子进程删除状态文件

### 回滚流程

1. 新代码导致服务启动失败（未发送 ready 信号或异常退出）
2. launcher 检测到启动失败，进入重试逻辑
3. 重试次数用尽后，执行回滚：
   - `git stash push` 暂存当前有问题的改动
   - 更新状态文件为 `rollback` 状态
   - 使用干净代码重新启动服务
4. 服务启动成功后，`git stash pop` 恢复改动到工作区
5. 服务向用户发送回滚通知和错误信息
6. 如果 stash pop 发生冲突，标记冲突状态

## 状态文件

文件名：`.restart-state.json`

```json
{
  "chatIds": ["oc_xxx"],
  "messageIds": ["om_xxx"],
  "status": "restarting",
  "timestamp": 1704067200000,
  "error": "错误信息（回滚时）",
  "hasConflict": false
}
```

## IPC 通信协议

### 子进程 → 父进程

| 消息类型 | 内容 | 说明 |
|---------|------|------|
| `ready` | `{ type: 'ready' }` | 服务启动完成 |
| `restart` | `{ type: 'restart', state: RestartState }` | 请求重启 |
| `error` | `{ type: 'error', error: string }` | 报告错误 |

### 父进程 → 子进程

| 消息类型 | 内容 | 说明 |
|---------|------|------|
| `state` | `{ type: 'state', state: RestartState }` | 发送状态（回滚后）|

## 使用方式

### 开发环境

```bash
# 使用 launcher 启动（推荐）
npm run launcher

# 调试模式
npm run launcher:debug
```

### 生产环境

```bash
# 使用 launcher 启动
npm run launcher

# 或使用进程管理器
pm2 start launcher.ts --name "feishu-bot" --interpreter tsx
```

### 重启服务

在飞书对话中发送：

```
/restart
```

机器人将回复重启结果。

## 故障排查

### 服务无法启动

1. 检查 `.restart-state.json` 是否包含错误信息
2. 查看 launcher 日志中的回滚记录
3. 手动执行 `git stash list` 查看是否有未恢复的改动

### IPC 通信失败

1. 确认 `process.send` 存在（launcher fork 的子进程才有）
2. 检查 launcher 日志中的消息记录
3. 直接使用 `npm run start` 测试业务服务是否正常

### 回滚冲突

如果 `git stash pop` 发生冲突：

1. 状态文件会标记 `hasConflict: true`
2. 需要手动解决冲突：`git status` 查看冲突文件
3. 解决后删除状态文件并重启服务
