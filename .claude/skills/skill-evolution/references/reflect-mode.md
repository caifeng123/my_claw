# Skill 失败反思模式

## 触发信号

**当以下情况发生时触发反思：**
- skill执行出错或返回错误结果
- 用户纠正skill的输出
- skill表现不如预期
- 用户明确要求改进skill

## 反思流程

### 1. 错误分析
```python
def analyze_error(error, user_feedback, skill_context):
    """分析错误根本原因"""
    # 错误类型分类
    error_types = [
        "knowledge_gap",      # 知识缺失
        "script_failure",     # 脚本失败
        "prompt_ambiguity",    # 提示模糊
        "context_missing",     # 上下文缺失
        "tool_misuse"         # 工具误用
    ]
    
    # 根据错误特征分类
    return classify_error_type(error)
```

### 2. 影响扫描
```python
def scan_impact(error_type, skill_usage):
    """扫描错误影响范围"""
    impacts = {
        "high": "影响核心功能，需要立即修复",
        "medium": "影响部分功能，建议修复",
        "low": "边缘问题，可延迟修复"
    }
    
    return assess_impact_level(error_type, skill_usage)
```

### 3. 改进建议生成
```python
def generate_improvements(error_analysis, impact_level):
    """生成具体改进建议"""
    improvements = []
    
    if error_analysis["type"] == "knowledge_gap":
        improvements.append("添加领域特定知识到references/")
    elif error_analysis["type"] == "script_failure":
        improvements.append("修复脚本错误并添加错误处理")
    
    return improvements
```

## 反思模板

### 错误分析报告
```markdown
## 🔍 错误分析报告

**错误类型**: {error_type}
**影响级别**: {impact_level}
**发生时间**: {timestamp}

### 根本原因
- {root_cause_1}
- {root_cause_2}

### 改进建议
1. {improvement_1}
2. {improvement_2}

### 预防措施
- {prevention_measure_1}
- {prevention_measure_2}
```

### 技能改进计划
```markdown
## 🚀 技能改进计划

**技能**: {skill_name}
**优先级**: {priority}
**预计完成时间**: {eta}

### 具体改进项
- [ ] 更新SKILL.md中的模糊描述
- [ ] 修复脚本{script_name}中的错误
- [ ] 添加{reference_name}参考文档
- [ ] 增加错误处理逻辑

### 测试验证
- [ ] 运行现有测试用例
- [ ] 添加新的边界测试
- [ ] 用户验收测试
```

## 升级机制

### 何时升级到成熟度检查
**满足以下条件时触发成熟度检查：**
- 成功修复3个以上错误
- 用户反馈积极
- skill稳定运行一段时间
- 覆盖主要使用场景

### 自动升级流程
```python
def auto_promote_to_maturity(skill_stats):
    """自动升级到成熟度检查"""
    criteria = {
        "error_fixes": 3,           # 成功修复错误数
        "positive_feedback": 0.8,   # 正面反馈比例
        "stable_duration": "7d",   # 稳定运行时间
        "coverage": 0.9            # 场景覆盖率
    }
    
    if meets_criteria(skill_stats, criteria):
        return "ready_for_maturity_check"
    else:
        return "needs_more_improvement"
```

## 反思工具

### 错误日志分析脚本
```bash
#!/bin/bash
# analyze-error-logs.sh - 分析skill错误日志

LOG_FILE="$1"
SKILL_NAME="$2"

# 分析错误模式
echo "分析错误日志: $LOG_FILE"

# 错误分类统计
grep -o "ERROR:.*" "$LOG_FILE" | sort | uniq -c | sort -nr

# 时间趋势分析
echo "错误时间分布:"
grep "ERROR:" "$LOG_FILE" | cut -d' ' -f1-3 | uniq -c

# 生成改进建议
echo "改进建议:"
echo "1. 检查高频错误类型"
echo "2. 分析错误发生时间模式"
echo "3. 验证修复效果"
```

### 用户反馈分析
```bash
#!/bin/bash
# analyze-feedback.sh - 分析用户反馈

FEEDBACK_FILE="$1"

# 情感分析（简单版）
positive=$(grep -i "好\|不错\|完美\|喜欢" "$FEEDBACK_FILE" | wc -l)
negative=$(grep -i "不好\|错误\|问题\|需要改进" "$FEEDBACK_FILE" | wc -l)

echo "正面反馈: $positive"
echo "负面反馈: $negative"

if [ $positive -gt $negative ]; then
    echo "✅ 反馈总体积极"
else
    echo "⚠️ 需要关注负面反馈"
fi
```

## 最佳实践

### 立即行动项
1. **记录每个错误** - 建立错误数据库
2. **分类错误类型** - 识别模式
3. **优先级排序** - 先修复高影响错误
4. **验证修复效果** - 确保问题真正解决

### 长期改进
1. **建立错误预防机制**
2. **定期反思回顾**
3. **收集用户反馈**
4. **持续优化skill**

记住：**失败是改进的机会**。每次错误都是让skill变得更好的契机。