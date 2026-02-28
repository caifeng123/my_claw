# Skill 评测模式

## 评测目的

评估skill的性能、可靠性和用户体验。通过定量和定性分析，确保skill达到预期标准。

## 评测类型

### 1. 功能正确性评测
```python
def test_functional_correctness(skill, test_cases):
    """测试skill功能正确性"""
    results = []
    for test_case in test_cases:
        expected = test_case["expected"]
        actual = skill.execute(test_case["input"])
        results.append({
            "test_case": test_case["name"],
            "passed": actual == expected,
            "expected": expected,
            "actual": actual
        })
    return results
```

### 2. 性能基准测试
```python
def benchmark_performance(skill, workload):
    """性能基准测试"""
    start_time = time.time()
    result = skill.execute(workload)
    end_time = time.time()
    
    return {
        "execution_time": end_time - start_time,
        "memory_usage": get_memory_usage(),
        "result_size": len(str(result))
    }
```

### 3. 用户体验评测
```python
def evaluate_user_experience(skill, user_feedback):
    """评估用户体验"""
    metrics = {
        "ease_of_use": 0.0,      # 易用性
        "reliability": 0.0,      # 可靠性
        "helpfulness": 0.0,      # 帮助性
        "response_time": 0.0     # 响应时间
    }
    
    # 分析用户反馈
    return analyze_feedback_metrics(user_feedback, metrics)
```

## 评测流程

### 1. 准备测试用例
```json
{
  "skill_name": "data-cleaner",
  "evals": [
    {
      "id": 1,
      "name": "基本数据清洗",
      "prompt": "清洗这个CSV文件中的空值",
      "input_files": ["test_data/dirty.csv"],
      "expected_output": "cleaned.csv with no null values",
      "assertions": [
        "输出文件存在",
        "没有空值",
        "行数正确"
      ]
    }
  ]
}
```

### 2. 运行评测
```bash
#!/bin/bash
# run-evals.sh - 运行skill评测

SKILL_PATH="$1"
EVAL_FILE="$2"
OUTPUT_DIR="$3"

# 创建评测工作区
mkdir -p "$OUTPUT_DIR/iteration-1"

# 运行每个测试用例
while IFS= read -r test_case; do
    eval_id=$(echo "$test_case" | jq -r '.id')
    eval_name=$(echo "$test_case" | jq -r '.name')
    
    echo "运行测试: $eval_name"
    
    # 使用skill执行测试
    result=$(claude --skill "$SKILL_PATH" --prompt "$test_case")
    
    # 保存结果
    echo "$result" > "$OUTPUT_DIR/iteration-1/eval-$eval_id/result.json"
    
done < <(jq -c '.evals[]' "$EVAL_FILE")
```

### 3. 分析结果
```python
def analyze_evaluation_results(results_dir):
    """分析评测结果"""
    metrics = {
        "pass_rate": 0.0,
        "avg_response_time": 0.0,
        "error_rate": 0.0,
        "user_satisfaction": 0.0
    }
    
    # 收集所有结果
    all_results = collect_results(results_dir)
    
    # 计算指标
    metrics["pass_rate"] = calculate_pass_rate(all_results)
    metrics["avg_response_time"] = calculate_avg_time(all_results)
    
    return metrics
```

## 评测指标

### 定量指标
- **通过率**：测试用例通过比例
- **响应时间**：平均执行时间
- **错误率**：失败请求比例
- **资源使用**：CPU/内存消耗

### 定性指标
- **用户满意度**：主观评价分数
- **易用性**：使用难度评估
- **可靠性**：稳定运行能力
- **帮助性**：实际帮助程度

## 评测工具

### 自动化评测脚本
```bash
#!/bin/bash
# auto-eval.sh - 自动化skill评测

SKILL_NAME="$1"
TEST_SET="$2"

# 创建评测配置
eval_config=$(cat << EOF
{
  "skill_name": "$SKILL_NAME",
  "test_set": "$TEST_SET",
  "metrics": ["pass_rate", "response_time", "user_satisfaction"],
  "iterations": 3
}
EOF
)

# 运行评测
for i in $(seq 1 3); do
    echo "迭代 $i"
    
    # 运行测试
    results=$(run_tests "$eval_config")
    
    # 分析结果
    analysis=$(analyze_results "$results")
    
    # 保存迭代结果
    echo "$analysis" > "results/iteration-$i/analysis.json"
done

# 生成综合报告
generate_report "results/"
```

### 结果可视化
```python
import matplotlib.pyplot as plt

def visualize_metrics(metrics_data):
    """可视化评测指标"""
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    
    # 通过率趋势
    axes[0,0].plot(metrics_data['pass_rates'])
    axes[0,0].set_title('通过率趋势')
    
    # 响应时间分布
    axes[0,1].hist(metrics_data['response_times'])
    axes[0,1].set_title('响应时间分布')
    
    # 错误类型分析
    axes[1,0].pie(metrics_data['error_types'].values(), labels=metrics_data['error_types'].keys())
    axes[1,0].set_title('错误类型分布')
    
    # 用户满意度
    axes[1,1].bar(metrics_data['satisfaction_scores'].keys(), metrics_data['satisfaction_scores'].values())
    axes[1,1].set_title('用户满意度')
    
    plt.tight_layout()
    plt.savefig('metrics_visualization.png')
```

## 回归测试

### 建立回归测试套件
```bash
#!/bin/bash
# regression-test.sh - 回归测试

SKILL_PATH="$1"
BASELINE_RESULTS="$2"

# 运行当前版本测试
current_results=$(run_tests "$SKILL_PATH")

# 比较与基线版本
comparison=$(compare_results "$BASELINE_RESULTS" "$current_results")

# 检查回归
if has_regression "$comparison"; then
    echo "⚠️ 检测到性能回归"
    echo "$comparison"
    exit 1
else
    echo "✅ 无回归，测试通过"
    exit 0
fi
```

## 最佳实践

### 评测设计原则
1. **代表性**：测试用例覆盖主要使用场景
2. **可重复性**：每次评测结果一致
3. **自动化**：减少人工干预
4. **持续集成**：每次修改都运行评测

### 结果解读指南
- **通过率>90%**：skill基本可用
- **响应时间<5s**：用户体验良好
- **错误率<5%**：可靠性达标
- **满意度>4/5**：用户接受度高

记住：**评测是改进的指南针**。通过系统化评测，持续优化skill质量。