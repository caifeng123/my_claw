// src/core/self-iteration/metadata-parser.ts
// 解析 SKILL.md frontmatter — 提取 metadata.personal 用于区分个人/他人 Skill

export interface SkillFrontmatter {
  name?: string
  metadata?: {
    personal?: string
    requires?: { bins?: string[] }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * 从 SKILL.md 内容解析 YAML frontmatter
 * 使用正则实现，不依赖 js-yaml
 */
export function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const yaml = match[1]
  const result: SkillFrontmatter = {}

  // name
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  if (nameMatch) {
    result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  // metadata.personal — 支持嵌套缩进格式
  const personalMatch = yaml.match(/personal:\s*(.+)$/m)
  if (personalMatch) {
    result.metadata = result.metadata ?? {}
    result.metadata.personal = personalMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  // metadata.requires.bins
  const binsMatch = yaml.match(/bins:\s*\[([^\]]*)\]/)
  if (binsMatch) {
    result.metadata = result.metadata ?? {}
    result.metadata.requires = {
      bins: binsMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean),
    }
  }

  return result
}

/**
 * 判断是否为个人 Skill（metadata.personal === 'cc'）
 */
export function isPersonalSkill(content: string): boolean {
  const fm = parseFrontmatter(content)
  return fm?.metadata?.personal === 'cc'
}
