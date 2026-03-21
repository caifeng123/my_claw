---
name: remote-computer-control
description: "远程计算机控制技能。当用户需要在远程桌面上执行操作时触发。支持场景：(1) 开播管理（'开播了'、'开始直播'、'开播'）(2) 下播管理（'下播'、'关掉浏览器'、'结束直播'）(3) 通用远程桌面操作（打开应用、浏览网页、文件操作等）。底层通过 Lumi CUA SDK 驱动远程沙箱执行。"
---

# Remote Computer Control

通过 Lumi CUA（Computer Use Agent）SDK 驱动远程 Windows 沙箱，执行用户指定的桌面操作任务。

## 项目结构

```
remote-computer-control/
├── SKILL.md                         # 本文件 — 技能定义与执行规范
├── references/
│   └── live_scenarios.md            # 直播场景专用流程（开播/下播）
└── scripts/
    ├── start.sh                     # 环境初始化（Go 依赖安装）
    ├── task_runner.js               # 任务编排器 — 图片处理 + Go 调用
    ├── task.go                      # 远程执行器 — 调用 Lumi CUA SDK
    ├── upload.js                    # CDN 图片上传工具
    ├── go.mod
    └── go.sum
```

运行时产出路径：
- `<PROJECT_ROOT>/data/temp/TASK_LIST.md` — 当次任务列表
- `<PROJECT_ROOT>/data/temp/final_screenshot.png` — 执行完成后的桌面截图
- `<PROJECT_ROOT>/data/temp/last_live_url.txt` — 上次使用的直播地址（自动记忆）

---

## 路由决策

收到用户请求后，**先判断意图类别再执行**：

| 意图 | 触发词示例 | 路由目标 |
|------|-----------|---------|
| 开播 | "开播了"、"开始直播"、"开播" | → 读取 `references/live_scenarios.md` 的「开播管理」章节 |
| 下播 | "下播"、"关掉浏览器"、"结束直播" | → 读取 `references/live_scenarios.md` 的「下播管理」章节 |
| 通用控制 | 其他远程操作请求 | → 进入下方「标准执行流程」 |

---

## 标准执行流程

**严格按顺序执行以下 6 步，不可跳步：**

### Step 1 — 环境初始化

```bash
bash $SKILL_DIR/scripts/start.sh
```

确保 Go 依赖就绪。仅首次执行或依赖变更时有实际开销。

### Step 2 — 制定 TASK_LIST

根据用户需求，将目标拆解为**远程桌面可执行的原子步骤列表**（纯文本）。

#### 编写规则

| 规则 | 说明 |
|------|------|
| **禁止截图指令** | TASK_LIST 中不允许出现任何"截图"、"截屏"、"screenshot"字样。截图由 `task.go` 在任务结束后自动完成 |
| **每步单一动作** | 一个步骤只做一件事：点击、输入、打开、等待… |
| **明确定位元素** | 用可见文字、坐标区域或 UI 层级描述目标元素，避免模糊指代 |
| **包含等待与验证** | 页面加载、动画等需要显式等待（如 "等待页面加载完成"） |
| **图片使用占位符** | 需要图片的位置写 `{IMAGE_URL}`，`task_runner.js` 会自动查找最新图片、上传 CDN 并替换 |

#### 示例

**纯文本任务：**
```
1: 打开Chrome浏览器，访问 https://github.com
2: 等待页面加载完成
3: 点击页面顶部搜索框
4: 输入 "OpenClaw" 并按回车
5: 在搜索结果中点击第一个仓库链接
6: 等待仓库页面加载完成
```

**含图片任务：**
```
1: 打开Chrome浏览器，访问 https://example.com/upload
2: 等待页面加载完成
3: 点击"上传图片"按钮
4: 在文件选择框中输入图片路径 {IMAGE_URL}
5: 点击"确认上传"按钮
6: 等待上传进度条完成
```

#### 反面示例（❌ 禁止）

```
# 以下写法均不允许：
1: 打开Chrome浏览器，访问知乎 https://www.zhihu.com 进行截图
2: 点击搜索框，输入"汕头"进行截图
3: 截图查看当前情况
```

### Step 3 — 写入任务文件

将 TASK_LIST 写入 `<PROJECT_ROOT>/data/temp/TASK_LIST.md`。

### Step 4 — 执行任务

```bash
node $SKILL_DIR/scripts/task_runner.js <PROJECT_ROOT>/data/temp/TASK_LIST.md
```

执行器内部流程：
1. 读取 TASK_LIST
2. 若包含 `{IMAGE_URL}` → 自动从 `data/lark/images/` 查找最新图片 → 上传 CDN → 替换占位符
3. 调用 `go run task.go` 将任务发送到远程沙箱
4. 通过 Lumi CUA SDK 流式接收执行过程消息
5. 执行完成后自动保存桌面截图到 `data/temp/final_screenshot.png`

### Step 5 — 结果验证与重试

检查 `<PROJECT_ROOT>/data/temp/final_screenshot.png`：

- **符合预期** → 进入 Step 6
- **不符合预期** → 分析失败原因，回到 **Step 2** 重新规划 TASK_LIST
- **判定无法完成** → 向用户说明原因并附上当前截图
- **最大重试次数**：3 次（含首次执行）。超过后停止并报告

### Step 6 — 发送结果截图

**必须**调用 `/image-send` skill，将截图发送给用户：

```
![截图](<PROJECT_ROOT>/data/temp/final_screenshot.png)
```

---

## 异常处理

| 场景 | 处理方式 |
|------|---------|
| 沙箱不存在 / 连接失败 | 通知用户"远程沙箱不可用"，建议检查沙箱状态 |
| Planner 服务繁忙 | 自动等待（5s 轮询），超过 60s 仍繁忙则通知用户 |
| 任务执行超时（>300s） | 保存当前截图，通知用户任务超时，建议拆分为更小的步骤 |
| 需要登录凭证 | 先发送当前截图给用户，请求用户提供登录信息，获取后继续 |
| 图片上传全部失败 | 使用原始 TASK_LIST 继续执行（无图模式），并告知用户 |
| `task.go` 编译/运行错误 | 检查 Go 环境，尝试重新执行 `start.sh`，仍失败则报告 |

---

## 性能与限制

- **单次任务超时**：300 秒（硬编码于 `task.go`）
- **并发限制**：同一沙箱同时只能执行一个任务，后续任务需排队
- **图片格式**：支持 `data/lark/images/` 下的任意图片格式，按文件名排序取最新批次
- **远程 OS**：当前仅支持 Windows 沙箱（通过 Lumi CUA ECS 管理）
