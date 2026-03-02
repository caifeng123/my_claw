---
name: remote-computer-control
description: 进行远程计算机控制的综合技能。当用户需要以下操作时触发此技能：远程桌面控制、AI驱动的任务自动化、鼠标键盘操作、屏幕截图捕获、远程GUI应用测试、跨计算机工作流自动化、批量远程操作任务。适用于需要控制远程计算机的任何场景，包括自动化测试、远程协助、批量操作等。
---

# Remote Computer Control

## 标准执行流程

**ALWAYS** 按照以下步骤执行远程控制任务：
1. 初始化项目目录：`sh $SKILL_DIR/scripts/start.sh`
2. 基于用户需求制定远程计算机需要做的细化 TASK_LIST 信息。
   - **如果任务需要图片处理**：在TASK_LIST中要求先下载图片到本地，图片使用占位符 `{IMAGE_URL}`
   - **如果任务不需要图片**：直接制定纯文本TASK_LIST
3. 将TASK_LIST记录在 $SKILL_DIR/scripts/TASK_LIST.md 文件中
4. 调用 `node $SKILL_DIR/scripts/task_runner.js $SKILL_DIR/scripts/TASK_LIST.md` 执行任务：
   - 检测到 `{IMAGE_URL}` 占位符时：自动查找最新图片、上传CDN，并替换占位符
   - 未检测到占位符时：直接执行原始TASK_LIST
5. 远程任务执行完成后，观察`</path/to/project>/data/temp/final_screenshot.png`与结果是否符合预期结果，若不符合则再次从第2步开始重新规划执行，若判定无法完成任务，则通知用户。
6. 结束任务前必须发送![final_screenshot](</path/to/project>/data/temp/final_screenshot.png)发送给用户

## TASK_LIST
基于用户需求，制定远程计算机需要做的细化 TASK_LIST 纯文本。每个 TASK 需要有清晰的执行步骤。

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