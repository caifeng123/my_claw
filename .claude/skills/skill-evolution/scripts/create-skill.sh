#!/bin/bash
# create-skill.sh - 创建新skill

# 简洁是关键：只输出必要信息
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates/skill-template"

# 帮助信息（自文档化）
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "创建新skill"
    echo "用法: $0 --name <skill-name> --description <description> [--template <template>]"
    echo ""
    echo "参数:"
    echo "  --name          skill名称（必需）"
    echo "  --description   skill描述（必需）"
    echo "  --template      使用的模板（可选）"
    exit 0
fi

# 参数解析
while [[ $# -gt 0 ]]; do
    case $1 in
        --name)
            SKILL_NAME="$2"
            shift 2
            ;;
        --description)
            DESCRIPTION="$2"
            shift 2
            ;;
        --template)
            TEMPLATE="$2"
            shift 2
            ;;
        *)
            echo "ERROR: 未知参数: $1"
            exit 1
            ;;
    esac
done

# 验证必需参数
if [[ -z "$SKILL_NAME" ]]; then
    echo "ERROR: 必须提供 --name 参数"
    exit 1
fi

if [[ -z "$DESCRIPTION" ]]; then
    echo "ERROR: 必须提供 --description 参数"
    exit 1
fi

# 创建skill目录
SKILL_DIR="$SCRIPT_DIR/../../$SKILL_NAME"
if [[ -d "$SKILL_DIR" ]]; then
    echo "ERROR: skill目录已存在: $SKILL_DIR"
    exit 1
fi

echo "创建skill: $SKILL_NAME"
mkdir -p "$SKILL_DIR"

# 创建SKILL.md
cat > "$SKILL_DIR/SKILL.md" << EOF
---
name: $SKILL_NAME
description: "$DESCRIPTION"
---

# $SKILL_NAME

基于skill-evolution框架创建的新skill。

## 功能特性

TODO: 描述skill的具体功能

## 使用示例

TODO: 提供使用示例

## 脚本说明

TODO: 描述相关脚本的功能

## 注意事项

TODO: 说明使用限制和注意事项
EOF

# 创建基础目录结构
mkdir -p "$SKILL_DIR/scripts"
mkdir -p "$SKILL_DIR/references"
mkdir -p "$SKILL_DIR/data"

# 创建基础脚本模板
cat > "$SKILL_DIR/scripts/start.sh" << 'EOF'
#!/bin/bash
# skill启动脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Skill启动完成: $(basename "$SCRIPT_DIR/..")"
EOF

chmod +x "$SKILL_DIR/scripts/start.sh"

# 创建README说明
cat > "$SKILL_DIR/README.md" << EOF
# $SKILL_NAME

$DESCRIPTION

## 快速开始

\`\`\`bash
# 初始化skill
./scripts/start.sh

# 使用skill功能
# TODO: 添加具体使用命令
\`\`\`

## 开发说明

这个skill基于skill-evolution框架创建，遵循"简洁是关键"的原则。

### 文件结构

- \`SKILL.md\` - 主要skill定义
- \`scripts/\` - 可执行脚本
- \`references/\` - 参考文档
- \`data/\` - 数据文件

### 质量要求

- 保持代码简洁
- 提供清晰的错误信息
- 支持渐进式披露
- 为agent设计，非人类
EOF

echo "✅ Skill创建完成: $SKILL_DIR"
echo ""
echo "📁 生成的文件:"
echo "- $SKILL_DIR/SKILL.md"
echo "- $SKILL_DIR/scripts/start.sh"
echo "- $SKILL_DIR/README.md"
echo ""
echo "🚀 下一步:"
echo "1. 编辑SKILL.md完善功能描述"
echo "2. 在scripts/添加具体实现"
echo "3. 在references/添加领域知识"
echo "4. 测试skill功能"

exit 0