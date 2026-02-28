---
name: remote-computer-control
description: 进行远程计算机控制的综合技能。当用户需要以下操作时触发此技能：远程桌面控制、AI驱动的任务自动化、鼠标键盘操作、屏幕截图捕获、远程GUI应用测试、跨计算机工作流自动化、批量远程操作任务。适用于需要控制远程计算机的任何场景，包括自动化测试、远程协助、批量操作等。
---

# Remote Computer Control

## 标准执行流程

**ALWAYS** 按照以下步骤执行远程控制任务：
1. 初始化项目目录：`sh $SKILL_DIR/scripts/start.sh`
2. 基于用户需求制定远程计算机需要做的细化 TASK_LIST 信息，每个 TASK 之间用逗号隔开。
   - **如果任务需要图片处理**：在TASK_LIST中使用占位符 `{IMAGE_URL}`
   - **如果任务不需要图片**：直接制定纯文本TASK_LIST
3. 调用 `cd $SKILL_DIR/scripts && ./smart_task_runner.sh "<TASK_LIST>"` 执行任务，智能执行器会：
   - 检测到 `{IMAGE_URL}` 占位符时：自动查找最新图片、上传CDN，并替换占位符
   - 未检测到占位符时：直接执行原始TASK_LIST
4. 远程任务执行完成后，观察`$SKILL_DIR/scripts/final_screenshot.png`与结果是否符合预期结果，若不符合则再次从第2步开始重新规划执行
5. 若确认任务完成，将 `$SKILL_DIR/scripts/final_screenshot.png` 文件发送给用户

## TASK_LIST
基于用户需求，制定远程计算机需要做的细化 TASK_LIST 纯文本。每个 TASK 需要有清晰的执行步骤。

### 使用占位符 `{IMAGE_URL}`
当任务需要图片处理时，在需要图片URL的位置使用 `{IMAGE_URL}` 占位符。智能执行器会自动替换为实际的CDN链接。

**示例：**
```
1: 打开浏览器访问taobao.com
2: 找到以图搜图功能按钮并点击
3: 上传图片文件: {IMAGE_URL}
4: 等待搜索结果加载完成
5: 截图保存搜索结果
```

**执行后智能执行器会自动替换为：**
```
1: 打开浏览器访问taobao.com
2: 找到以图搜图功能按钮并点击
3: 上传图片文件: lf3-static.bytednsdoc.com/obj/.../image.jpg
4: 等待搜索结果加载完成
5: 截图保存搜索结果
```

### 纯文本任务
当任务不需要图片时，直接制定纯文本TASK_LIST。

**示例：**
```
1: 打开浏览器访问github.com
2: 搜索OpenClaw项目
3: 查看项目README文件
4: 截图保存页面
```

## Scripts
- `scripts/task.go`: 执行任务的主程序
- `scripts/start.sh`: 准备项目目录，安装依赖

## 注意事项
- 任务执行过程中，若出现异常情况，应及时通知用户并记录日志
- 若需要app登录，则向用户请求登录后再执行任务