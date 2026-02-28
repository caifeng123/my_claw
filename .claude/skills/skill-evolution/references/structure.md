# Skill 创建与结构化

## 核心原则：简洁是关键

上下文窗口是共享资源。只添加Claude没有的上下文。挑战每个部分："Claude真的需要这个吗？"

## 何时创建Skill

**创建skill当：**
- 发现重复使用的模式
- 有非显而易见的领域知识
- 需要特定工具脚本
- 现有skill无法覆盖80%用例

**不创建skill当：**
- 只使用一次
- 一行CLAUDE.md规则可覆盖
- 没有可重用脚本且没有特殊知识

## Skill 结构模板

```
skill-name/
├── SKILL.md (必需)
│   ├── YAML frontmatter (name, description)
│   └── Markdown指令
├── scripts/ (可选)
│   └── 可执行代码
├── references/ (可选)
│   └── 渐进式加载文档
└── assets/ (可选)
    └── 输出文件模板
```

## SKILL.md 最佳实践

### Frontmatter 格式
```yaml
---
name: skill-name
description: "何时触发，做什么。包含触发场景和具体功能。"
---
```

### 内容指南
- **保持≤150行**（路由层）
- 将详细场景移到references/
- 偏好具体示例而非抽象解释
- 挑战每一行："删除会出错吗？"

## 渐进式披露

三级加载系统：
1. **元数据**（name + description）- 始终在上下文
2. **SKILL.md主体** - skill触发时加载
3. **捆绑资源** - 按需加载

## 脚本设计原则

```bash
#!/bin/bash
# Token-light输出：只打印调用者需要的内容

# 清晰参数名
--document-id 而非 --did
--verbose 仅用于调试

# 错误格式：ERROR: 关键细节在同一行
ERROR: File not found: /path/to/file

# 退出码：0=成功，非零=失败
exit 0  # 成功
exit 1  # 失败
```

## 创建流程

1. **捕获意图**：用户想要skill做什么？
2. **分析模式**：这是重复模式吗？
3. **设计结构**：需要脚本吗？需要参考文档吗？
4. **编写SKILL.md**：遵循简洁原则
5. **测试验证**：运行几个测试用例

## 示例：创建数据清洗skill

**SKILL.md frontmatter:**
```yaml
---
name: data-cleaner
description: "数据清洗和预处理。当用户需要清洗CSV/Excel数据、处理缺失值、标准化格式时触发。"
---
```

**脚本设计：**
```python
#!/usr/bin/env python3
# 数据清洗脚本 - 为agent设计

import pandas as pd
import sys

def main():
    # 轻量token输出
    if "--help" in sys.argv:
        print("Clean CSV data: remove nulls, standardize format")
        print("Usage: clean-data.py --input file.csv --output cleaned.csv")
        return
    
    # 处理输入
    input_file = sys.argv[sys.argv.index("--input") + 1]
    df = pd.read_csv(input_file)
    
    # 数据清洗逻辑
    df_clean = df.dropna().reset_index(drop=True)
    
    # 保存结果
    output_file = sys.argv[sys.argv.index("--output") + 1]
    df_clean.to_csv(output_file, index=False)
    
    # 简洁输出
    print(f"Cleaned {len(df)} -> {len(df_clean)} rows")

if __name__ == "__main__":
    main()
```

记住：**简洁是关键**。每个添加的内容都必须为Claude增加价值。