---
name: github-mr-creator
description: 自动化GitHub Pull Request创建流程：自动推送代码并创建PR，指派给用户自己，使用业内规范的PR模板。支持自定义PR标题和描述模板。当用户需要创建GitHub PR、提交代码到远程仓库、自动化代码审查流程时触发此技能。即使未明确提及"PR"或"pull request"，只要用户需要推送代码并创建合并请求，就应使用此技能。
---

# GitHub Pull Request Creator

此技能自动化GitHub Pull Request（在GitHub中称为PR，不是GitLab的MR）的创建流程。它处理从当前状态到创建PR的所有必要步骤。

## 核心工作流程

当此技能触发时，按照以下步骤操作：

### 1. 准备阶段

**获取当前状态：**
- 运行 `git status` 查看未跟踪的文件和更改
- 运行 `git branch` 查看当前分支
- 运行 `git log -1` 查看最近的提交信息，了解仓库的提交风格

**收集必要信息：**
- 检查是否有远程仓库：`git remote -v`
- 如果没有远程仓库，询问用户仓库URL
- 确认当前分支是否需要创建新分支还是使用现有分支

### 2. 创建并切换到新分支（如果需要）

如果用户没有指定分支名，或当前在主分支（main/master）上：
- 生成一个合理的分支名，基于最近的提交类型（feat/fix/docs/refactor等）
- 格式：`<type>/<short-description>`
- 示例：`feat/user-authentication`, `fix/login-bug`, `docs/update-readme`

### 3. 提交代码

**创建提交信息：**
- 使用conventional commits格式：`<type>(<scope>): <description>`
- Type选项：
  - `feat`: 新功能
  - `fix`: 修复bug
  - `docs`: 文档更新
  - `style`: 代码格式（不影响功能）
  - `refactor`: 重构
  - `test`: 添加测试
  - `chore`: 构建/工具变更
- 示例：`feat(auth): add JWT token authentication`

**执行提交：**
- 添加相关文件：`git add <files>`（避免使用 `git add -A` 或 `git add .`，除非用户明确要求）
- 创建提交：
  ```bash
  git commit -m "$(cat <<'EOF'
  <commit message>

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  EOF
  )"
  ```

### 4. 推送到远程仓库

**推送分支：**
- 使用 `-u` 标志设置上游：`git push -u origin <branch-name>`
- 如果推送失败，检查错误信息并提供解决方案

### 5. 创建Pull Request

**获取用户信息：**
- 运行 `gh api user` 获取当前GitHub用户名
- 获取用户ID用于PR指派

**确定基础分支：**
- 检查仓库的默认分支：`gh repo view --json defaultBranchRef`
- 如果无法确定，询问用户目标分支

**创建PR：**
使用业内规范的PR模板，通过 `gh pr create` 命令创建：

```bash
gh pr create \
  --title "<PR title>" \
  --body "$(cat <<'EOF'
## 变更概述
<简洁描述此PR的目的和变更内容>

## 变更类型
- [ ] 新功能 (feature)
- [ ] Bug修复 (bug fix)
- [ ] 文档更新 (documentation)
- [ ] 代码重构 (refactoring)
- [ ] 性能优化 (performance)
- [ ] 测试相关 (test)

## 详细变更
<详细说明具体的变更内容>
- 列出主要变更点
- 说明为什么需要这些变更
- 提供技术细节

## 相关Issue
Closes #(issue number)

## 测试计划
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 手动测试完成
- [ ] 相关文档已更新

## Checklist
- [ ] 代码遵循项目编码规范
- [ ] 已添加必要的测试
- [ ] 文档已更新
- [ ] 无console.log或调试代码
- [ ] 变更已通过本地测试

## 截图/录屏（如果适用）
<如果有UI变更，添加截图或GIF>

## 备注
<任何额外的说明或注意事项>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --assignee @me \
  --base <base-branch>
```

**PR标题格式：**
- 遵循conventional commits格式，但更详细
- 格式：`<type>(<scope>): <short description>`
- 示例：`feat(auth): implement JWT-based authentication with refresh tokens`

### 6. 确认和报告

**向用户报告：**
```markdown
✅ Pull Request已成功创建！

**PR详情：**
- 标题：<PR title>
- 分支：<branch> → <base-branch>
- 指派给自己：@<username>
- 链接：<PR URL>

**下一步：**
1. 检查PR描述和变更内容
2. 等待CI/CD检查完成
3. 请求代码审查
```

## 特殊情况处理

### 没有未提交的更改
如果 `git status` 显示没有需要提交的更改：
- 询问用户是否需要创建新的提交
- 或是否要为现有提交创建PR

### 推送冲突
如果 `git push` 遇到冲突：
1. 运行 `git pull --rebase origin <base-branch>`
2. 解决冲突（如有）
3. 重新推送

### PR已存在
如果该分支已存在PR：
- 提示用户现有PR的URL
- 询问是否需要更新现有PR或创建新分支

### 获取失败
如果 `gh` 命令失败：
1. 检查是否已安装GitHub CLI
2. 检查是否已认证：`gh auth status`
3. 提供安装和认证指导

## 最佳实践

1. **保持PR简洁**：每个PR应该专注单一目的
2. **提供充分的上下文**：让审查者理解变更的原因
3. **包含测试计划**：说明如何验证变更
4. **使用清晰的标题**：让审查者快速了解PR内容
5. **及时响应反馈**：在PR讨论中积极回应

## 参考资源

- [GitHub Pull Request文档](https://docs.github.com/en/pull-requests)
- [Conventional Commits规范](https://www.conventionalcommits.org/)
- [GitHub CLI文档](https://cli.github.com/manual/gh_pr_create)
