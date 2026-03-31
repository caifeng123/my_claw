// src/core/self-iteration/practice-injector.ts
// 他人 Skill：在 SKILL.md 末尾幂等追加调用实践 section 引用

import { writeFileSync } from 'node:fs'

const PRACTICE_HEADER = '## 调用实践'

const PRACTICE_BLOCK = `
${PRACTICE_HEADER}
必须阅读以下内容：
- 最佳实践(iteration/best-practices.md): 最佳实践
- 最差实践(iteration/pitfalls.md): 注意避免的错误实践
`

/**
 * 检查 SKILL.md 是否已包含调用实践 section
 */
export function hasPracticeSections(content: string): boolean {
  return content.includes(PRACTICE_HEADER)
}

/**
 * 向 SKILL.md 末尾追加调用实践引用
 * 幂等：已存在则跳过
 */
export function appendPracticeSections(
  skillMdPath: string,
  content: string,
): { appended: boolean; reason: string } {
  if (hasPracticeSections(content)) {
    return { appended: false, reason: 'Section already exists' }
  }

  const newContent = content.trimEnd() + '\n' + PRACTICE_BLOCK
  writeFileSync(skillMdPath, newContent, 'utf-8')

  return { appended: true, reason: 'Appended 调用实践 section' }
}
