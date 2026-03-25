# my_claw 项目架构总结

## 一、项目整体概述

**my_claw** 是一个**基于 Anthropic Claude Agent SDK 构建的单用户 AI Agent 系统**，深度集成飞书（Feishu/Lark）生态。它实现了一个全功能的 AI 助手后端，支持通过飞书消息与 Agent 对话、流式卡片回复、定时任务、持久化记忆、网页搜索、图片安全处理等能力。

**技术栈**：TypeScript + Hono（HTTP 框架）+ Claude Agent SDK + 飞书 Open API + JSONL 持久化存储

---

## 二、架构分层

| 层级 | 模块 | 核心职责 |
|------|------|----------|
| **HTTP 路由层** | `src/routes/` | 对外暴露 REST API，包括 Agent 会话、飞书 Webhook、记忆管理 |
| **Agent 编排层** | `src/core/agent/` | Agent 引擎核心，负责 LLM 调用、上下文管理、工具调度、流式响应 |
| **工具层** | `src/core/agent/tools/` | 为 Agent 提供可调用的工具集（搜索、计算器、记忆、定时任务、链接分析） |
| **飞书服务层** | `src/services/feishu/` | 飞书消息收发、WebSocket 连接、OAuth 认证、流式卡片渲染 |
| **记忆系统** | `src/core/memory/` | 对话历史持久化、KV 记忆库、N-gram 搜索、重要度衰减与驱逐 |
| **定时任务系统** | `src/core/cronjob/` | Cron 表达式调度、任务执行、执行日志记录 |
| **配置与工具** | `src/config/`, `src/utils/`, `scripts/` | 环境变量、飞书配置、路径管理、进程管理器、CLI 工具 |
| **Skills 技能层** | `.claude/skills/` | Claude Code 技能定义，包含飞书操作、深度研究、Git PR 等 20+ 个技能 |

---

## 三、各模块详解

### 1. HTTP 路由层（`src/routes/`）

| 文件 | 功能 |
|------|------|
| `agent.ts` | Agent 交互 API：创建会话、发送消息（支持流式 SSE）、获取历史、中止对话 |
| `feishu.ts` | 飞书管理 API：查看连接状态、登录/登出、重连、刷新 Token |
| `memory.ts` | 记忆 CRUD API：查看/搜索/删除/更新记忆条目，查看/清空对话历史 |

### 2. Agent 编排引擎（`src/core/agent/engine/`）

这是项目的**核心模块**，负责 Agent 的完整运行时：

| 文件 | 功能 |
|------|------|
| `claude-engine.ts` | 封装 Claude Agent SDK 的 `query()` 异步生成器，支持流式输出、Sub-Agent 感知、VisionGuard 集成、工具调用拦截 |
| `llm-engine.ts` | 基于 OpenAI 兼容 API 的轻量 LLM 引擎，用于辅助任务（如生成对话摘要） |
| `context-builder.ts` | 上下文窗口管理：增量对话压缩、Token 预算控制、图片分析缓存、自动裁剪以避免超出上下文限制 |
| `session-manager.ts` | 会话管理：按会话 ID 维护独立对话线程，支持文件持久化和摘要缓存 |
| `system-prompt-builder.ts` | 动态系统提示词构建：注入当前时间、高重要度记忆、用户上下文到 system prompt |
| `tool-manager.ts` | 工具注册与管理：将自定义工具注册为 MCP Server，与 SDK 内置工具协同使用 |
| `vision-guard.ts` | 视觉安全三层防御：system prompt 限制 + hook 拦截 + canUseTool 守卫，确保图片内容通过隔离的 haiku 模型 Sub-Agent 处理，不进入主 Agent 上下文 |

**Agent 入口**（`src/core/agent/index.ts`）：`AgentEngine` 类作为中央协调器，组合上述所有子系统，支持流式与非流式消息处理。

### 3. 工具集（`src/core/agent/tools/`）

Agent 可通过自然语言调用的 5 类内置工具：

| 工具 | 功能 |
|------|------|
| `calculator.ts` | 数学计算 + 当前时间/日期查询 |
| `tavily-tools.ts` | 基于 Tavily API 的网页搜索，支持摘要和内容提取 |
| `memory-tools.ts` | 记忆 CRUD：读取、保存、删除、搜索持久化记忆 |
| `cronjob-tools.ts` | 定时任务管理：创建/查询/删除/更新 Cron 任务 |
| `link-analyze.ts` | URL 内容抓取与分析：支持 HTML 解析、PDF 提取、YouTube 字幕获取 |

### 4. 飞书服务层（`src/services/feishu/`）

| 文件 | 功能 |
|------|------|
| `feishu-service.ts` | 飞书核心服务：WebSocket 长连接接收消息、发送文本/富文本/图片/文件消息、消息引用解析、图片上传下载 |
| `feishu-agent-bridge.ts` | 飞书 ↔ Agent 桥接：将飞书消息路由到 Agent，将 Agent 回复推送回飞书聊天 |
| `streaming-card-renderer.ts` | 流式卡片渲染器：实时更新飞书交互式卡片，支持 Markdown 分块、Sub-Agent 步骤嵌套展示、工具调用状态可视化 |
| `device-auth.ts` | OAuth 2.0 设备码授权流程：生成登录链接、轮询 Token、自动刷新 |
| `user-auth-service.ts` | 用户 Token 管理：持久化存储、自动续期心跳、过期检测 |
| `types.ts` | 飞书相关类型定义：事件结构、消息格式、卡片数据结构等 |

### 5. 记忆系统（`src/core/memory/`）

| 文件 | 功能 |
|------|------|
| `memory-db.ts` | KV 记忆库：JSONL 持久化、N-gram + Jaccard 关键词搜索、同义词索引、重要度排序、超量自动驱逐（按重要度衰减） |
| `conversation-store.ts` | 对话历史存储：每会话独立文件、文件轮转、摘要缓存、图片分析结果缓存 |
| `config.ts` | 记忆配置常量：最大条目数、搜索限制、上下文 Token 预算等 |

**记忆系统设计要点**：

- **持久化格式**：采用 JSONL（每行一条 JSON），追加写入性能高，避免全量序列化
- **搜索机制**：N-gram 分词后计算 Jaccard 相似度，支持中文分词与同义词扩展
- **驱逐策略**：当记忆条目超出上限时，按"重要度 × 时间衰减"排序，自动淘汰低优先级条目
- **对话管理**：每个会话独立文件存储，超过阈值自动轮转到归档文件，避免单文件过大

### 6. 定时任务系统（`src/core/cronjob/`）

| 文件 | 功能 |
|------|------|
| `cron-scheduler.ts` | Cron 调度器：基于 `node-cron` 解析表达式并按时触发任务执行 |
| `cron-executor.ts` | 任务执行器：支持三种类型——Agent 提示词执行、飞书通知（静态/AI 生成）、自定义 Shell 脚本 |
| `cron-store.ts` | 任务持久化：JSON 文件存储任务定义，JSONL 记录执行日志 |
| `types.ts` | 类型定义：任务结构、执行结果、执行日志等 |

**定时任务支持三种执行模式**：

1. **Agent Prompt**：将预设提示词发送给 Agent 执行，结果推送到飞书
2. **飞书通知**：发送静态文本或 AI 动态生成的消息到指定飞书聊天
3. **Shell 脚本**：执行自定义脚本，捕获 stdout/stderr 作为执行结果

### 7. 脚本与工具（`scripts/`）

| 文件 | 功能 |
|------|------|
| `launcher.ts` | 进程管理器：启动/监控主进程、支持 git-based 回滚、崩溃自动重启 |
| `memory-cli.ts` | 记忆 CLI：命令行查看/搜索/操作记忆库（调试用） |
| `device-auth-login.ts` | OAuth 登录 CLI：终端交互式完成飞书设备码授权 |
| `feishu-cli-wrapper.sh` | Token 注入包装器：为 feishu-cli 命令自动注入认证 Token |

### 8. Skills 技能层（`.claude/skills/`）

项目内置了 **20+ 个 Claude Code 技能定义**，覆盖飞书文档操作全流程：

| 技能分类 | 包含技能 |
|----------|---------|
| **飞书文档** | read（读取）、write（写入）、search（搜索）、import/export（导入导出）、perm（权限） |
| **飞书协作** | chat（群组）、msg（消息/卡片）、board（白板）、doc-guide（文档指南） |
| **开发运维** | git-pr（PR 管理）、skill-creator（技能创建）、skill-dev（技能开发） |
| **高级功能** | deep-research（深度研究）、remote-computer-control（远程控制）、image-upload/send（图片处理） |
| **知识管理** | learn-kb（飞书知识库链接）、feishu-notify-admin（管理员通知） |

---

## 四、数据流概览

```
用户飞书消息
    ↓
FeishuService (WebSocket 长连接接收)
    ↓
FeishuAgentBridge (消息路由 + 上下文提取)
    ↓
AgentEngine (编排核心)
    ├→ ContextBuilder (上下文压缩 + Token 预算控制)
    ├→ SystemPromptBuilder (动态 Prompt 注入高重要度记忆)
    ├→ ClaudeEngine (Claude SDK 调用)
    │   ├→ ToolManager (工具调度: 搜索/计算/记忆/定时任务/链接分析)
    │   └→ VisionGuard (图片安全隔离 → Sub-Agent 处理)
    └→ SessionManager (会话持久化)
    ↓
StreamingCardRenderer (流式卡片渲染 + Sub-Agent 步骤可视化)
    ↓
FeishuService (飞书消息回复)
```

---

## 五、关键设计亮点

### 5.1 三层视觉安全防御

通过 system prompt + hook + canUseTool 三层机制，确保图片二进制数据永远不进入主 Agent 上下文，而是路由到隔离的轻量模型（haiku）Sub-Agent 处理。这一设计在保留多模态能力的同时，避免了图片数据污染主对话上下文或泄露到不安全的工具调用中。

### 5.2 增量对话压缩

ContextBuilder 自动将历史对话摘要化，在 Token 预算内保留最大信息量。当对话轮次增长导致 Token 超限时，会自动触发摘要压缩，将早期对话替换为 LLM 生成的摘要。

### 5.3 高重要度记忆注入

SystemPromptBuilder 在每次对话时，自动从记忆库中提取高重要度条目注入 system prompt，让 Agent "永远记得"关键信息（如用户偏好、常用设置等），无需用户重复说明。

### 5.4 流式卡片渲染

StreamingCardRenderer 支持实时更新飞书交互卡片，包括：
- Markdown 分块渐进式渲染
- Sub-Agent 嵌套步骤的折叠/展开展示
- 工具调用状态可视化（调用中/完成/失败）
- 思考过程（thinking）的独立展示区域

### 5.5 用户级定时任务

用户可通过自然语言创建 Cron 任务，支持三种执行模式：
- **Agent 执行**：将预设 prompt 交给 Agent 处理并推送结果
- **飞书推送**：静态文本或 AI 动态生成的消息
- **Shell 脚本**：执行自定义命令

---

## 六、项目目录结构

```
my_claw/
├── .claude/skills/              # Claude Code 技能定义（20+ 个）
│   ├── deep-research/           # 深度研究技能
│   ├── feishu-cli-*/            # 飞书操作系列技能（读/写/搜索/导入导出/权限/消息/白板等）
│   ├── git-pr/                  # Git PR 管理技能
│   ├── image-upload/            # 图片上传技能
│   ├── remote-computer-control/ # 远程控制技能
│   ├── skill-creator/           # 技能创建工具
│   └── skill-dev/               # 技能开发工具
├── data/                        # 运行时数据目录（会话、记忆、定时任务持久化）
├── scripts/                     # CLI 工具与进程管理
│   ├── launcher.ts              # 进程管理器（启动/监控/回滚）
│   ├── memory-cli.ts            # 记忆库 CLI
│   ├── device-auth-login.ts     # 飞书 OAuth 登录 CLI
│   └── feishu-cli-wrapper.sh    # 飞书 CLI Token 注入
├── src/
│   ├── index.ts                 # 应用入口（Hono 服务启动）
│   ├── env-setup.ts             # 环境变量初始化
│   ├── config/                  # 配置
│   │   ├── feishu.ts            # 飞书配置（App ID/Secret/加密等）
│   │   └── feishu-scopes.ts     # OAuth 权限范围注册表
│   ├── core/
│   │   ├── agent/               # Agent 核心
│   │   │   ├── index.ts         # AgentEngine 入口
│   │   │   ├── engine/          # 引擎子系统
│   │   │   │   ├── claude-engine.ts        # Claude SDK 封装
│   │   │   │   ├── llm-engine.ts           # 轻量 LLM 引擎
│   │   │   │   ├── context-builder.ts      # 上下文管理
│   │   │   │   ├── session-manager.ts      # 会话管理
│   │   │   │   ├── system-prompt-builder.ts # 系统提示词
│   │   │   │   ├── tool-manager.ts         # 工具管理
│   │   │   │   └── vision-guard.ts         # 视觉安全
│   │   │   ├── handlers/
│   │   │   │   └── stream-handler.ts       # 流式事件处理
│   │   │   ├── tools/           # 内置工具
│   │   │   │   ├── calculator.ts           # 计算器
│   │   │   │   ├── tavily-tools.ts         # 网页搜索
│   │   │   │   ├── memory-tools.ts         # 记忆操作
│   │   │   │   ├── cronjob-tools.ts        # 定时任务
│   │   │   │   └── link-analyze.ts         # 链接分析
│   │   │   └── types/           # Agent 类型定义
│   │   ├── cronjob/             # 定时任务系统
│   │   │   ├── cron-scheduler.ts           # 调度器
│   │   │   ├── cron-executor.ts            # 执行器
│   │   │   ├── cron-store.ts               # 持久化
│   │   │   └── types.ts                    # 类型
│   │   └── memory/              # 记忆系统
│   │       ├── memory-db.ts                # KV 记忆库
│   │       ├── conversation-store.ts       # 对话存储
│   │       └── config.ts                   # 配置常量
│   ├── routes/                  # HTTP 路由
│   │   ├── agent.ts             # Agent 会话 API
│   │   ├── feishu.ts            # 飞书管理 API
│   │   └── memory.ts            # 记忆管理 API
│   ├── services/feishu/         # 飞书服务
│   │   ├── feishu-service.ts              # 核心服务
│   │   ├── feishu-agent-bridge.ts         # Agent 桥接
│   │   ├── streaming-card-renderer.ts     # 流式卡片
│   │   ├── device-auth.ts                 # 设备码认证
│   │   ├── user-auth-service.ts           # Token 管理
│   │   └── types.ts                       # 类型定义
│   └── utils/
│       └── paths.ts             # 路径管理工具
├── Claude.md                    # Agent 行为规则定义
├── package.json                 # 项目依赖
└── tsconfig.json                # TypeScript 配置
```
