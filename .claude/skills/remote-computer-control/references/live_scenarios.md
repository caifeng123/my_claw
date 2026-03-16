# 直播控制场景

## 开播管理

### 触发指令
- "开播了"、"开始直播"、"开播"

### 执行流程

1. **确认直播 URL**
   - **首次使用或地址未记录时**：
     - 询问用户是否使用默认地址：`https://www.tiktok.com/@funwave2000th/live`
     - 若用户提供自定义 URL，使用用户提供的地址
   - **已有记录地址时**：
     - 询问用户："使用上次地址（{上次地址}）还是其他地址？"
     - 提供快速选项：1) 使用上次地址 2) 输入新地址
   - **记录最终确认的 URL** 到 `data/temp/last_live_url.txt` 以供后续使用

2. **生成 TASK_LIST**
   ```
   1: 打开PowerShell
   2: 执行 C:\Users\ecs\Desktop\multi.bat {URL}
   3: 等待5秒确认浏览器窗口已打开
   ```

3. **调用执行**
   ```bash
   node $SKILL_DIR/scripts/task_runner.js <PROJECT_ROOT>/data/temp/TASK_LIST.md
   ```

4. **验证结果**
   - 检查 `final_screenshot.png` 是否显示直播页面
   - 确认浏览器窗口已正常打开且加载了目标 URL

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| `multi.bat` 不存在 | 通知用户批处理文件缺失，请求确认路径 |
| URL 无效或无法加载 | 发送截图给用户，请求确认正确的直播 URL |
| 浏览器未启动 | 尝试直接通过 `start chrome {URL}` 打开，仍失败则报告 |

---

## 下播管理

### 触发指令
- "下播"、"关掉浏览器"、"结束直播"

### 执行流程

1. **生成 TASK_LIST**
   ```
   1: 打开PowerShell
   2: 执行 C:\Users\ecs\Desktop\kill_chrome.bat
   3: 等待3秒确认进程已终止
   ```

2. **调用执行**
   ```bash
   node $SKILL_DIR/scripts/task_runner.js <PROJECT_ROOT>/data/temp/TASK_LIST.md
   ```

3. **验证结果**
   - 检查 `final_screenshot.png` 确认桌面上已无 Chrome 窗口
   - 若仍有残留窗口，生成补充 TASK_LIST 使用 `taskkill /F /IM chrome.exe` 强制终止

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| `kill_chrome.bat` 不存在 | 改用 `taskkill /F /IM chrome.exe` 命令直接终止 |
| 无 Chrome 进程运行 | 通知用户"当前没有运行中的直播浏览器" |
| 部分进程未终止 | 重试一次强制终止，仍失败则报告残留进程信息 |
