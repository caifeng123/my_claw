---
name: remote-computer-control
description: 进行远程计算机控制的综合技能。当用户需要远程桌面控制时触发此技能。特别支持：开播管理（"开播了"、"开始直播"、"开播"）和下播管理（"下播"、"关掉浏览器"、"结束直播"）。适用于需要控制远程计算机的任何场景。
---

# Remote Computer Control

## 目录
.
├── .claude
├── skills
│   └── remote-computer-control
│       ├── scripts
│       ├── references
│       │   └── live_scenarios.md
│       └── SKILL.md
├── Claude.md
├── data
│   └── temp
│       ├── TASK_LIST.md
│       └── final_screenshot.png
├── package.json
├── pnpm-lock.yaml
├── scripts
└── src

## 路由系统

根据用户意图智能路由到相应场景：

- **开播管理**（触发指令："开播了"、"开始直播"、"开播"）→ 读取 `references/live_scenarios.md`
- **下播管理**（触发指令："下播"、"关掉浏览器"、"结束直播"）→ 读取 `references/live_scenarios.md`
- **通用远程控制**（其他远程操作需求）→ 按照标准执行流程处理

## 标准执行流程

**ALWAYS** 按照以下步骤执行远程控制任务：
1. 初始化项目目录：`sh $SKILL_DIR/scripts/start.sh`
2. 基于用户需求制定远程计算机需要做的细化 TASK_LIST 信息。
   - **如果任务需要图片处理**：在TASK_LIST中要求先下载图片到本地，图片使用占位符 `{IMAGE_URL}`
   - **如果任务不需要图片**：直接制定纯文本TASK_LIST
3. 将TASK_LIST记录在 </path/to/project>/data/temp/TASK_LIST.md 文件中
4. 调用 `node $SKILL_DIR/scripts/task_runner.js </path/to/project>/data/temp/TASK_LIST.md` 执行任务：
   - 检测到 `{IMAGE_URL}` 占位符时：自动查找最新图片、上传CDN，并替换占位符
   - 未检测到占位符时：直接执行原始TASK_LIST
5. 远程任务执行完成后，观察`</path/to/project>/data/temp/final_screenshot.png`与结果是否符合预期结果，若不符合则再次从第2步开始重新规划执行，若判定无法完成任务，则通知用户。
6. 最后必须调用/image-send skill，将![截图](</path/to/project>/data/temp/final_screenshot.png)发送给用户

## TASK_LIST
基于用户需求，制定远程计算机需要做的细化 TASK_LIST 纯文本。每个 TASK 需要有清晰的执行步骤。
### **严格遵守**
1. ❌ 不要在TASK_LIST中要求截图
- ❌ bad case:
   - 打开Chrome浏览器，访问知乎网站 https://www.zhihu.com 进行截图
   - 点击搜索框，输入"汕头"进行截图
   - 点击搜索按钮执行搜索，截图当前结果
   - 查看搜索结果的商品列表进行截图
   - 截图查看当前情况

- ✅ good case:
   - 打开Chrome浏览器，访问知乎网站 https://www.zhihu.com
   - 点击搜索框，输入"汕头"
   - 点击搜索按钮执行搜索
   - 查看搜索结果的商品列表

### 使用占位符 `{IMAGE_URL}`
当任务需要图片处理时，在需要图片URL的位置使用 `{IMAGE_URL}` 占位符。task_runner.js 会自动替换为实际的CDN链接。

### 纯文本任务
当任务不需要图片时，直接制定纯文本TASK_LIST。

**示例：**
```
1: 打开浏览器访问github.com
2: 搜索OpenClaw项目
3: 查看项目README文件
```

## Scripts
- `scripts/task_runner.js`: 组装TASK_LIST，执行任务
- `scripts/task.go`: 真实操作远程计算机的脚本
- `scripts/start.sh`: 准备项目目录，安装依赖

## 注意事项
- 任务执行过程中，若出现异常情况，应及时通知用户并记录日志
- 若需要app登录，需先向用户请求登录凭证（发送最终截图），再执行任务
- TASK_LIST 里不要做截图操作，截图操作在task.go中实现