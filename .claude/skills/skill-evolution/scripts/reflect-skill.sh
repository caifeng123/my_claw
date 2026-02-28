#!/bin/bash
# reflect-skill.sh - skill失败反思和改进

set -e

# 帮助信息
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "skill失败反思和改进"
    echo "用法: $0 --skill-path <path> [--error-log <log>] [--user-feedback <feedback>]"
    echo ""
    echo "参数:"
    echo "  --skill-path     skill路径（必需）"
    echo "  --error-log      错误日志文件（可选）"
    echo "  --user-feedback  用户反馈（可选）"
    exit 0
fi

# 参数解析
while [[ $# -gt 0 ]]; do
    case $1 in
        --skill-path)
            SKILL_PATH="$2"
            shift 2
            ;;
        --error-log)
            ERROR_LOG="$2"
            shift 2
            ;;
        --user-feedback)
            USER_FEEDBACK="$2"
            shift 2
            ;;
        *)
            echo "ERROR: 未知参数: $1"
            exit 1
            ;;
    esac
done

# 验证必需参数
if [[ -z "$SKILL_PATH" ]]; then
    echo "ERROR: 必须提供 --skill-path 参数"
    exit 1
fi

if [[ ! -d "$SKILL_PATH" ]]; then
    echo "ERROR: skill路径不存在: $SKILL_PATH"
    exit 1
fi

SKILL_NAME=$(basename "$SKILL_PATH")
REFLECT_DIR="$SKILL_PATH/reflect-$(date +%Y%m%d-%H%M%S)"

# 创建反思目录
mkdir -p "$REFLECT_DIR"

echo "🔍 开始反思skill: $SKILL_NAME"
echo "反思目录: $REFLECT_DIR"

# 分析错误类型
analyze_errors() {
    local error_log="$1"
    local analysis_file="$REFLECT_DIR/error-analysis.md"
    
    echo "## 错误分析" > "$analysis_file"
    echo "生成时间: $(date)" >> "$analysis_file"
    echo "" >> "$analysis_file"
    
    if [[ -f "$error_log" ]]; then
        echo "### 错误统计" >> "$analysis_file"
        grep -o "ERROR:.*" "$error_log" | sort | uniq -c | sort -nr >> "$analysis_file"
        echo "" >> "$analysis_file"
        
        echo "### 错误类型分类" >> "$analysis_file"
        # 简单错误分类
        knowledge_errors=$(grep -c -i "未知\|不认识\|不了解" "$error_log" || true)
        script_errors=$(grep -c -i "脚本\|执行失败\|命令" "$error_log" || true)
        prompt_errors=$(grep -c -i "模糊\|不清楚\|误解" "$error_log" || true)
        
        echo "- 知识缺失错误: $knowledge_errors" >> "$analysis_file"
        echo "- 脚本执行错误: $script_errors" >> "$analysis_file"
        echo "- 提示模糊错误: $prompt_errors" >> "$analysis_file"
    else
        echo "未提供错误日志文件" >> "$analysis_file"
    fi
    
    echo "✅ 错误分析完成: $analysis_file"
}

# 生成改进建议
generate_improvements() {
    local improvements_file="$REFLECT_DIR/improvements.md"
    
    echo "## 改进建议" > "$improvements_file"
    echo "生成时间: $(date)" >> "$improvements_file"
    echo "" >> "$improvements_file"
    
    # 基于错误分析生成建议
    if [[ -f "$REFLECT_DIR/error-analysis.md" ]]; then
        error_analysis=$(cat "$REFLECT_DIR/error-analysis.md")
        
        # 知识缺失错误建议
        if echo "$error_analysis" | grep -q "知识缺失错误" && [[ $(echo "$error_analysis" | grep -o "知识缺失错误: [0-9]*" | cut -d: -f2) -gt 0 ]]; then
            echo "### 知识缺失改进" >> "$improvements_file"
            echo "- [ ] 添加领域特定知识到references/" >> "$improvements_file"
            echo "- [ ] 完善SKILL.md中的功能描述" >> "$improvements_file"
            echo "- [ ] 提供更多使用示例" >> "$improvements_file"
            echo "" >> "$improvements_file"
        fi
        
        # 脚本错误建议
        if echo "$error_analysis" | grep -q "脚本执行错误" && [[ $(echo "$error_analysis" | grep -o "脚本执行错误: [0-9]*" | cut -d: -f2) -gt 0 ]]; then
            echo "### 脚本改进" >> "$improvements_file"
            echo "- [ ] 修复脚本中的错误" >> "$improvements_file"
            echo "- [ ] 添加更好的错误处理" >> "$improvements_file"
            echo "- [ ] 完善脚本文档" >> "$improvements_file"
            echo "" >> "$improvements_file"
        fi
        
        # 提示模糊错误建议
        if echo "$error_analysis" | grep -q "提示模糊错误" && [[ $(echo "$error_analysis" | grep -o "提示模糊错误: [0-9]*" | cut -d: -f2) -gt 0 ]]; then
            echo "### 提示改进" >> "$improvements_file"
            echo "- [ ] 澄清SKILL.md中的模糊描述" >> "$improvements_file"
            echo "- [ ] 提供更具体的示例" >> "$improvements_file"
            echo "- [ ] 添加上下文使用指南" >> "$improvements_file"
            echo "" >> "$improvements_file"
        fi
    fi
    
    # 用户反馈建议
    if [[ -n "$USER_FEEDBACK" ]]; then
        echo "### 用户反馈改进" >> "$improvements_file"
        echo "用户反馈: $USER_FEEDBACK" >> "$improvements_file"
        echo "- [ ] 分析用户反馈的具体问题" >> "$improvements_file"
        echo "- [ ] 根据反馈优化功能" >> "$improvements_file"
        echo "- [ ] 验证改进效果" >> "$improvements_file"
        echo "" >> "$improvements_file"
    fi
    
    # 通用改进建议
    echo "### 通用改进" >> "$improvements_file"
    echo "- [ ] 运行测试验证修复效果" >> "$improvements_file"
    echo "- [ ] 更新文档反映改进" >> "$improvements_file"
    echo "- [ ] 考虑成熟度升级检查" >> "$improvements_file"
    
    echo "✅ 改进建议生成完成: $improvements_file"
}

# 生成反思报告
generate_report() {
    local report_file="$REFLECT_DIR/reflection-report.md"
    
    echo "# Skill反思报告: $SKILL_NAME" > "$report_file"
    echo "生成时间: $(date)" >> "$report_file"
    echo "" >> "$report_file"
    
    # 汇总分析结果
    echo "## 执行摘要" >> "$report_file"
    echo "- **Skill名称**: $SKILL_NAME" >> "$report_file"
    echo "- **反思时间**: $(date)" >> "$report_file"
    echo "- **错误日志**: ${ERROR_LOG:-未提供}" >> "$report_file"
    echo "- **用户反馈**: ${USER_FEEDBACK:-未提供}" >> "$report_file"
    echo "" >> "$report_file"
    
    # 包含错误分析
    if [[ -f "$REFLECT_DIR/error-analysis.md" ]]; then
        echo "## 错误分析" >> "$report_file"
        tail -n +3 "$REFLECT_DIR/error-analysis.md" >> "$report_file"
        echo "" >> "$report_file"
    fi
    
    # 包含改进建议
    if [[ -f "$REFLECT_DIR/improvements.md" ]]; then
        echo "## 改进建议" >> "$report_file"
        tail -n +3 "$REFLECT_DIR/improvements.md" >> "$report_file"
        echo "" >> "$report_file"
    fi
    
    # 下一步行动
    echo "## 下一步行动" >> "$report_file"
    echo "1. 审查错误分析报告" >> "$report_file"
    echo "2. 实施改进建议" >> "$report_file"
    echo "3. 测试验证改进效果" >> "$report_file"
    echo "4. 考虑成熟度评估" >> "$report_file"
    echo "" >> "$report_file"
    
    echo "## 反思总结" >> "$report_file"
    echo "每次错误都是改进的机会。通过系统化反思，持续提升skill质量。" >> "$report_file"
    
    echo "✅ 反思报告生成完成: $report_file"
}

# 执行反思流程
analyze_errors "$ERROR_LOG"
generate_improvements
generate_report

echo ""
echo "🎯 反思完成摘要:"
echo "- 错误分析: $REFLECT_DIR/error-analysis.md"
echo "- 改进建议: $REFLECT_DIR/improvements.md"
echo "- 完整报告: $REFLECT_DIR/reflection-report.md"
echo ""
echo "🚀 下一步建议:"
echo "1. 审查反思报告"
echo "2. 实施关键改进"
echo "3. 测试验证效果"
echo "4. 考虑发布准备"

exit 0