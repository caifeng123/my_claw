/**
 * 手动触发夜间自迭代分析
 *
 * 用法：
 *   npx tsx scripts/test-nightly.ts                  # 分析所有有 trace 的 Skill
 *   npx tsx scripts/test-nightly.ts lark-im           # 只分析指定 Skill
 *   npx tsx scripts/test-nightly.ts lark-im,my-tool   # 分析多个 Skill
 */

import { config } from 'dotenv'
import { ClaudeEngine } from '../src/core/agent/engine/claude-engine.js'
import { IterationChecker } from '../src/core/self-iteration/iteration-checker.js'
config()

async function main() {
  const arg = process.argv[2]

  // 解析 skill filter
  const skillFilter: 'all' | string[] = arg
    ? arg.split(',').map(s => s.trim())
    : 'all'

  console.log(`\n🧪 [Test] 手动触发 Nightly 分析`)
  console.log(`   filter: ${JSON.stringify(skillFilter)}`)
  console.log(`   time:   ${new Date().toISOString()}\n`)

  const engine = new ClaudeEngine()
  const checker = new IterationChecker(engine)

  const report = await checker.runNightly(skillFilter)

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📋 分析报告`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`运行时间: ${report.runAt}`)
  console.log(`技能数量: ${report.skills.length}\n`)

  for (const skill of report.skills) {
    const icon = skill.action === 'optimized' ? '🔧' :
                 skill.action === 'analyzed' ? '📊' :
                 skill.action === 'error' ? '❌' : '⏭️'
    console.log(`${icon} ${skill.skillName}: ${skill.action} — ${skill.reason}`)
  }

  if (report.skills.length === 0) {
    console.log(`⏭️ 没有发现有今日 trace 的 Skill`)
    console.log(`   检查路径: .claude/skills/{skillName}/iteration/traces/${new Date().toISOString().slice(0, 10)}.jsonl`)
  }

  console.log(`\n${'═'.repeat(60)}\n`)
}

main().catch(err => {
  console.error('❌ 执行失败:', err)
  process.exit(1)
})