# cf_claw项目从零搭建规划文档

## 项目概述
cf_claw是一个基于Claude Agent SDK的单用户AI Agent系统，具备分层memory、skill、飞书交互等核心能力。

## 核心能力需求

### 1. Agent能力（Claude Agent SDK）
**实现方式：**
- 使用`@anthropic-ai/claude-agent-sdk`作为底层AI引擎
- 支持流式输出和工具调用
- 实现MCP（Model Context Protocol）工具集

**关键组件：**
- Agent运行器：负责执行AI任务
- 工具注册系统：动态注册和管理工具
- 会话管理：维护对话上下文

### 2. 分层Memory系统
**设计架构：**
- **会话级Memory**：当前对话的短期记忆
- **用户级Memory**：用户跨会话的长期记忆
- **项目级Memory**：系统级别的共享记忆
- **自动归档**：对话历史自动归档机制

**实现要点：**
- 文件系统存储（Markdown格式）
- 全文搜索能力
- 记忆容量限制和清理策略

### 3. 飞书交互能力
**实现功能：**
- WebSocket长连接实时通信
- 富文本卡片消息渲染
- 用户身份验证和授权
- topic 管理，每个topic对应一个独立的会话，用户可以在不同topic之间切换。

**技术栈：**
- `@larksuiteoapi/node-sdk` - 飞书官方SDK
- WebSocket服务器 - 实时消息推送
- 消息队列 - 异步处理消息

## 技术选型

### 后端技术栈
- **运行时**：Bun + TypeScript
- **Web框架**：Hono（轻量级、高性能）
- **存储方案**：文件系统存储+SQLite数据库
- **飞书通信**：飞书SDK内置WebSocket长连接
- **配置管理**：dotenv + JSON配置文件

### 开发工具
- **包管理**：Bun内置包管理
- **开发服务器**：Bun内置热重载
- **代码质量**：ESLint + Prettier
- **测试框架**：Bun内置测试工具

## 系统架构设计

### 整体架构
```
cf_claw/
├── src/
│   ├── core/           # 核心模块
│   │   ├── agent/      # Agent引擎
│   │   ├── memory/     # 记忆系统
│   ├── services/       # 业务服务
│   │   ├── feishu/     # 飞书服务
│   │   ├── auth/       # 认证服务
│   │   └── storage/    # 存储服务
│   └── utils/         # 工具函数
├── skills/           # 内置Skills
├── config/           # 配置文件
└── scripts/          # 构建和部署脚本
```

## 关键依赖和资源

### 核心依赖
- `@anthropic-ai/claude-agent-sdk` - AI引擎
- `@larksuiteoapi/node-sdk` - 飞书集成（内置WebSocket长连接）
- `hono` - Web框架（轻量级、高性能）
- `bun:sqlite3` - SQLite数据库驱动

### 开发依赖
- `typescript` - TypeScript编译器
- `ts-node` - TypeScript运行时
- `eslint` + `prettier` - 代码质量

### 参考资源
1. **Claude Agent SDK文档**：了解核心API和工具调用
2. **飞书开放平台文档**：了解消息格式和API限制
3. **MCP协议规范**：设计工具调用接口
4. **现有类似项目**：参考架构设计思路

## 风险评估和应对

### 技术风险
1. **Claude SDK稳定性** - 使用稳定版本，充分测试
2. **飞书API变更** - 抽象接口层，便于适配
3. **性能瓶颈** - 早期进行性能测试和优化

### 项目风险
1. **功能范围蔓延** - 明确MVP范围，迭代开发
2. **开发周期延长** - 设定明确的里程碑
3. **团队协作** - 建立清晰的代码规范和文档

## 成功标准

### MVP（最小可行产品）标准
1. ✅ Agent基础对话功能正常
2. ✅ 分层Memory系统可读写
3. ✅ 基本Skill加载和执行
4. ✅ 飞书消息收发功能
5. ✅ 本地开发环境一键启动

### 完整功能标准
1. ✅ 多用户支持和完善的权限管理
2. ✅ Skill加载和执行
3. ✅ 生产环境部署和监控
4. ✅ 性能优化和稳定性保障

[] Agent核心引擎 (src/core/agent/)
[] 分层Memory系统 (src/core/memory/)
[] 飞书服务集成 (src/services/feishu/)