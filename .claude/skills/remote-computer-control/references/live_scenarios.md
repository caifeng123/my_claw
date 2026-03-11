# 直播控制场景

## 开播管理
### 触发指令
- "开播了"、"开始直播"、"开播"

### 执行流程
1. **确认URL**：询问用户是否使用默认地址 `https://www.tiktok.com/@funwave2000th/live`
2. **生成TASK_LIST**：
   ```
   1: 打开PowerShell
   2: 执行 C:\Users\ecs\Desktop\multi.bat {URL}
   ```
3. **调用执行**：使用task_runner.js执行TASK_LIST
4. **验证结果**：检查final_screenshot.png是否显示直播页面

### 错误处理
- 如果multi.bat不存在：尝试其他路径或通知用户
- 如果URL无效：重新确认

## 下播管理
### 触发指令
- "下播"、"关掉浏览器"、"结束直播"

### 执行流程
1. **生成TASK_LIST**：
   ```
   1: 打开PowerShell
   2: 执行 C:\Users\ecs\Desktop\kill_chrome.bat
   ```
2. **调用执行**：使用task_runner.js执行TASK_LIST
3. **验证结果**：检查Chrome进程是否终止

### 错误处理
- 如果kill_chrome.bat不存在：尝试其他终止方式
- 如果没有Chrome进程：通知用户