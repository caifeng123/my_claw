---
name: skill-evolution
description: "Skill全生命周期管理：创建→反思优化→评测→成熟度判断→发布→检索→选择/安装→融合迭代→卸载。触发场景：(1)用户要求创建/修改skill (2)发现可提取为skill的重复模式 (3)skill执行出错或用户纠正后需要反思改进 (4)用户要求发布/搜索/安装/合并社区skill (5)反思后自动检查成熟度并建议发布"
---

# Skill Evolution

基于skill-evolution项目的全生命周期skill管理。遵循"简洁是关键"和"自由度匹配"的核心原则。

## 核心原则

### 简洁是关键

上下文窗口是共享资源。只添加Claude没有的上下文。挑战每个部分："Claude真的需要这个吗？" 偏好简洁示例而非冗长解释。

### 自由度匹配

根据任务的脆弱性匹配特异性：

- **高自由度**（文本指令）：多种方法有效，上下文相关决策
- **中自由度**（带参数的伪代码/脚本）：存在首选模式，允许一些变化
- **低自由度**（特定脚本）：操作脆弱，一致性关键，需要精确顺序

## 路由系统

**本地生命周期（无需注册表）：**
- **创建/结构化skill**（目录布局、SKILL.md格式、渐进式披露、验证）→ 读取 `references/structure.md`
- **skill失败后反思**（触发信号、反思过程、影响扫描、升级）→ 读取 `references/reflect-mode.md`
- **评测skill提示**（eval、跑回归、检查prompt改动效果）→ 读取 `references/eval-mode.md`
- **检查skill成熟度**（反思后、成功运行后、"成熟了吗"、"该发布了吗"）→ 读取 `references/maturity.md`

**注册表生命周期（内置公共注册表，开箱即用）：**
- **发布skill**（"publish"、"发布skill"、"开源这个skill"）→ 读取 `references/publish.md`
- **搜索/安装**（"search skill"、"有没有XX的skill"、"安装skill"）→ 读取 `references/search.md`
- **评价skill**（"review"、"评价skill"、"打分"）→ 使用 `scripts/review.py`
- **合并skill变体**（"merge"、"合并版本"、"融合"）→ 读取 `references/merge.md`
- **卸载skill**（"uninstall"、"删除skill"、"卸载"）→ 使用 `scripts/uninstall.py --name <skill> --yes`

## 何时不创建Skill

不要为假设的未来需求构建。如果满足以下任何条件，跳过：
- 只使用一次 — 直接内联完成
- 一行CLAUDE.md规则覆盖 — 直接编辑CLAUDE.md
- 没有可重用脚本且没有非显而易见的知识 — Claude已经知道怎么做
- 现有skill处理80%+用例 — 扩展它而不是新建

## 脚本设计

工具设计比提示设计更重要。当skill有`scripts/`时，投资质量：

- **轻量token输出**：只打印调用者需要的内容。`--verbose`仅用于调试。
- **可搜索错误**：所有错误以`ERROR:`开头，关键细节在同一行。
- **自文档化**：支持`--help`，包含一行描述和参数列表。
- **清晰参数名**：使用直观名称（`--document-id`，不是`--did`）。
- **绝对路径**：接受和输出绝对路径。
- **退出码**：0 = 成功，非零 = 失败。
- **为agent设计，非人类**：输出结构化数据，非格式化文本。
- **渐进式披露**：截断输出必须包含总数据大小和如何查看更多。JSON：添加`total`/`has_more`/`page_token`。文本：附加`(N chars total)` + stderr `HINT:` 包含继续命令。

## 渐进式路由

根据用户意图智能路由到相应模块：

```python
# 路由逻辑示例
def route_skill_request(user_input):
    if "创建" in user_input or "新建" in user_input:
        return "structure"
    elif "失败" in user_input or "出错" in user_input:
        return "reflect"
    elif "评测" in user_input or "测试" in user_input:
        return "eval"
    elif "发布" in user_input or "开源" in user_input:
        return "publish"
    elif "搜索" in user_input or "安装" in user_input:
        return "search"
    else:
        return "analyze"  # 自动分析意图
```

## 写作指南

- **包含**：非显而易见的过程、领域特定知识、真实失败的经验教训
- **不包含**：Claude已经知道的内容、冗长解释、辅助文档
- **保持** SKILL.md ≤150行（路由层）；将场景细节移到references/
- **挑战每一行**："删除这个会导致Claude犯错吗？" 如果不会，删除它。
- **偏好示例而非解释**：一个具体对比例子比一段文字教得更多

## 快速开始

**创建新skill：**
```bash
cd scripts && ./create-skill.sh --name "my-skill" --description "技能描述"
```

**反思skill失败：**
```bash
cd scripts && ./reflect-skill.sh --skill-path path/to/skill --error-log error.log
```

**评测skill性能：**
```bash
cd scripts && ./eval-skill.sh --skill-path path/to/skill --test-cases tests/
```

## 文件结构

```
skill-evolution/
├── SKILL.md (本文件)
├── references/          # 渐进式加载的参考文档
│   ├── structure.md     # skill创建和结构化
│   ├── reflect-mode.md  # 失败反思模式
│   ├── eval-mode.md     # 性能评测模式
│   ├── maturity.md      # 成熟度评估
│   ├── publish.md       # 发布到注册表
│   ├── search.md        # 搜索和安装
│   └── merge.md         # 变体合并
├── scripts/             # 可执行脚本
│   ├── create-skill.sh  # 创建新skill
│   ├── reflect-skill.sh # 反思改进
│   ├── eval-skill.sh    # 性能评测
│   ├── review.py       # skill评价
│   └── uninstall.py    # 卸载skill
└── templates/          # 模板文件
    ├── skill-template/
    └── eval-template/
```

## 质量保证

每个skill生命周期阶段都有对应的质量检查：

1. **创建时**：结构完整性、文档清晰度
2. **反思时**：错误分析、改进建议
3. **评测时**：性能指标、用户体验
4. **发布时**：成熟度评估、社区标准

记住：**简洁是关键**。挑战每个添加的内容，确保它真正为Claude增加价值。