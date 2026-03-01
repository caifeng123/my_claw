# Launcher 启动器实现总结

## 已完成的工作

### 1. 创建了 launcher.ts（父进程）

**文件位置**: `/data00/home/caifeng.nice/myclaw/my_claw/launcher.ts`

**核心功能**:
- 使用 `fork()` 启动子进程运行业务服务
- 通过 IPC 与业务服务通信
- 监控子进程退出状态
- 启动失败时执行自动回滚（git stash）
- 处理状态文件通知

**关键流程**:
1. fork 子进程并设置 IPC 通信
2. 等待子进程发送 `ready` 信号（30秒超时）
3. 收到 `ready` 后确认服务启动成功
4. 子进程异常退出时，执行重试和回滚逻辑

### 2. 修改了 src/index.ts（业务服务/子进程）

**新增功能**:
- 启动成功后通过 IPC 发送 `ready` 信号给 launcher
- 处理 `/restart` 指令，写入状态文件并优雅退出
- 启动时检查状态文件，向用户发送重启结果通知
- 监听 launcher 发送的状态更新消息

**关键代码**:
```typescript
// 启动成功后通知 launcher
if (process.send) {
  process.send({ type: 'ready' })
}

// 处理 /restart 指令
if (trimmedContent === '/restart') {
  await this.handleRestartCommand(message)
  return
}
```

### 3. 修改了 src/services/feishu/feishu-agent-bridge.ts

**新增功能**:
- 添加 `handleRestartCommand` 方法处理 `/restart` 指令
- 写入 `.restart-state.json` 状态文件
- 向用户发送确认消息
- 延迟后退出进程触发重启

**状态文件结构**:
```json
{
  "chatIds": ["oc_xxx"],
  "messageIds": ["om_xxx"],
  "status": "restarting",
  "timestamp": 1704067200000
}
```

### 4. 更新了 package.json

**新增脚本**:
```json
{
  "scripts": {
    "launcher": "tsx launcher.ts",
    "launcher:debug": "DEBUG=1 tsx launcher.ts"
  }
}
```

### 5. 创建了文档和测试脚本

- `LAUNCHER.md` - 详细的使用文档
- `LAUNCHER_SUMMARY.md` - 本总结文档
- `scripts/test-launcher.sh` - 测试脚本

## 使用方式

### 启动服务

```bash
# 使用 launcher 启动（推荐）
npm run launcher

# 调试模式
npm run launcher:debug
```

### 重启服务

在飞书对话中发送：
```
/restart
```

机器人将：
1. 回复 "正在重启服务，请稍候..."
2. 写入状态文件
3. 退出进程
4. launcher 重新启动服务
5. 发送重启结果通知

## 故障排查

### 服务无法启动

1. 检查 `.restart-state.json` 是否包含错误信息
2. 查看 launcher 日志中的回滚记录
3. 手动执行 `git stash list` 查看是否有未恢复的改动

### IPC 通信失败

1. 确认 `process.send` 存在（launcher fork 的子进程才有）
2. 检查 launcher 日志中的消息记录
3. 直接使用 `npm run start` 测试业务服务是否正常

## 架构优势

1. **无热更新干扰** - Claude Code 修改文件不会触发意外重启
2. **手动控制重启** - 用户通过 `/restart` 指令精确控制重启时机
3. **自动回滚保障** - 新代码导致启动失败时自动回滚到旧版本
4. **状态通知机制** - 重启结果通过飞书主动通知用户
5. **优雅关闭** - SIGTERM 信号处理确保服务优雅关闭
