# Skill 发布管理

## 发布准备

### 发布前检查清单
```markdown
## 发布前最终检查

### 功能完整性
- [ ] 所有核心功能稳定
- [ ] 边界情况处理完善
- [ ] 错误处理机制健全

### 代码质量
- [ ] 代码通过质量检查
- [ ] 测试覆盖率达标
- [ ] 文档完整准确

### 用户体验
- [ ] 用户反馈积极
- [ ] 响应时间合理
- [ ] 易用性良好

### 社区准备
- [ ] README文档完善
- [ ] 使用示例清晰
- [ ] 许可证选择合适
```

### 发布流程
```python
def publish_skill(skill, registry="community"):
    """发布skill到注册表"""
    # 1. 验证发布条件
    if not meets_publish_criteria(skill):
        return "发布条件不满足"
    
    # 2. 生成发布包
    package = create_package(skill)
    
    # 3. 提交到注册表
    result = submit_to_registry(package, registry)
    
    # 4. 发布确认
    if result["success"]:
        return f"发布成功！版本: {result['version']}"
    else:
        return f"发布失败: {result['error']}"
```

## 版本管理

### 语义化版本
```bash
# 版本格式: MAJOR.MINOR.PATCH
# MAJOR: 不兼容的API修改
# MINOR: 向下兼容的功能性新增
# PATCH: 向下兼容的问题修正

# 版本发布命令
./scripts/publish.sh --version 1.0.0 --changelog "初始发布"
```

### 版本历史记录
```markdown
# 版本历史

## v1.0.0 (2024-01-15)
- 初始发布
- 核心功能实现
- 基础文档完成

## v1.1.0 (2024-01-20)
- 新增高级功能
- 性能优化
- 用户体验改进

## v1.1.1 (2024-01-25)
- 修复已知问题
- 文档更新
```

## 社区发布

### 发布到技能市场
```python
def publish_to_marketplace(skill_package):
    """发布到技能市场"""
    marketplace_api = "https://skills.marketplace.ai"
    
    # 准备发布数据
    publish_data = {
        "name": skill_package["name"],
        "version": skill_package["version"],
        "description": skill_package["description"],
        "category": skill_package["category"],
        "tags": skill_package["tags"],
        "license": skill_package["license"]
    }
    
    # 提交发布
    response = requests.post(f"{marketplace_api}/publish", json=publish_data)
    
    return response.json()
```

### 发布检查脚本
```bash
#!/bin/bash
# publish-check.sh - 发布前检查

SKILL_PATH="$1"

# 检查skill完整性
echo "🔍 检查skill完整性..."

# 必需文件检查
required_files=("SKILL.md" "README.md" "scripts/")
for file in "${required_files[@]}"; do
    if [[ ! -e "$SKILL_PATH/$file" ]]; then
        echo "❌ 缺少必需文件: $file"
        exit 1
    fi
done

# 代码质量检查
echo "📊 检查代码质量..."
if ! check_code_quality "$SKILL_PATH"; then
    echo "❌ 代码质量检查失败"
    exit 1
fi

# 功能测试
echo "🧪 运行功能测试..."
if ! run_functional_tests "$SKILL_PATH"; then
    echo "❌ 功能测试失败"
    exit 1
fi

echo "✅ 所有检查通过，准备发布！"
```

## 发布后维护

### 问题跟踪
```python
def track_issues(skill_name):
    """跟踪发布后问题"""
    issues_api = f"https://api.github.com/repos/{skill_name}/issues"
    
    # 获取问题列表
    issues = requests.get(issues_api).json()
    
    # 分类问题
    bug_issues = [issue for issue in issues if "bug" in issue["labels"]]
    feature_requests = [issue for issue in issues if "enhancement" in issue["labels"]]
    
    return {
        "total_issues": len(issues),
        "bugs": len(bug_issues),
        "feature_requests": len(feature_requests)
    }
```

### 版本支持策略
```markdown
# 版本支持策略

## 当前版本支持
- **v2.x**: 完全支持，定期更新
- **v1.x**: 安全更新，有限支持

## 生命周期
- **活跃支持**: 最新主要版本
- **安全支持**: 上一个主要版本
- **终止支持**: 更早版本

## 升级指南
- 建议升级到最新版本
- 主要版本升级可能有破坏性变更
- 查看CHANGELOG了解具体变更
```

## 最佳实践

### 发布清单
1. **功能验证** - 确保所有功能正常工作
2. **文档更新** - README和文档同步更新
3. **测试通过** - 所有测试用例通过
4. **版本标记** - 正确标记版本号
5. **发布说明** - 清晰的发布说明

### 社区参与
- 及时响应问题
- 定期更新维护
- 收集用户反馈
- 参与社区讨论

记住：**发布是开始，不是结束**。持续维护和更新是skill成功的关键。