/**
 * Memory CLI - 命令行查看/搜索/导出记忆
 * V4.1 - 支持 list / search / stats / dump / compact / dedup
 *
 * 用法:
 *   tsx scripts/memory-cli.ts list [--cat <category>] [--source <source>] [--limit <n>]
 *   tsx scripts/memory-cli.ts search <query>
 *   tsx scripts/memory-cli.ts stats
 *   tsx scripts/memory-cli.ts dump [--format md|jsonl]
 *   tsx scripts/memory-cli.ts compact
 */

import { MemoryDB } from '../src/core/memory/memory-db.js'
import { MEMORY_CONFIG } from '../src/core/memory/config.js'

const db = new MemoryDB(MEMORY_CONFIG.DB_PATH)
const [, , command, ...args] = process.argv

function getFlag(flags: string[], flag: string): string | undefined {
  const idx = flags.indexOf(flag)
  return idx >= 0 ? flags[idx + 1] : undefined
}

function printHelp(): void {
  console.log(`
📝 Memory CLI - V4.1 记忆管理工具

Commands:
  list [--cat <category>] [--source <source>] [--limit <n>]
    列出记忆条目

  search <query>
    FTS5 全文搜索

  stats
    显示统计信息

  dump [--format md|jsonl]
    导出全部记忆

  compact
    手动触发容量淘汰

  help
    显示此帮助信息

Categories: preference | decision | context | correction | instruction | knowledge
Sources: USER | PROJECT | GLOBAL
  `)
}

switch (command) {
  case 'list': {
    const cat = getFlag(args, '--cat')
    const source = getFlag(args, '--source')
    const limit = parseInt(getFlag(args, '--limit') || '50')

    let entries
    if (cat) {
      entries = db.getByCategory(cat, limit)
    } else if (source) {
      entries = db.getBySource(source, limit)
    } else {
      entries = db.getTopMemories(limit)
    }

    if (entries.length === 0) {
      console.log('📭 暂无记忆条目')
      break
    }

    console.table(entries.map(e => ({
      id: e.id,
      source: e.source,
      cat: e.cat,
      imp: e.imp,
      text: e.text.slice(0, 60) + (e.text.length > 60 ? '...' : ''),
      updated: e.updated_at,
    })))
    console.log(`\n共 ${entries.length} 条记忆`)
    break
  }

  case 'search': {
    const query = args[0]
    if (!query) {
      console.error('❌ Usage: search <query>')
      process.exit(1)
    }

    const results = db.search(query, 20)
    if (results.length === 0) {
      console.log('📭 未找到匹配的记忆')
      break
    }

    console.table(results.map(r => ({
      id: r.id,
      cat: r.cat,
      imp: r.imp,
      score: r.score.toFixed(2),
      text: r.text.slice(0, 60) + (r.text.length > 60 ? '...' : ''),
    })))
    console.log(`\n共找到 ${results.length} 条匹配记忆`)
    break
  }

  case 'stats': {
    const stats = db.getStats()
    console.log(`\n📊 Memory 统计信息`)
    console.log(`${'─'.repeat(40)}`)
    console.log(`总记忆条数: ${stats.total}`)
    console.log(`容量上限: ${MEMORY_CONFIG.CAPACITY.MAX_ENTRIES}`)
    console.log(`\n按分类:`)
    if (Object.keys(stats.byCategory).length > 0) {
      console.table(stats.byCategory)
    } else {
      console.log('  (空)')
    }
    console.log(`\n按来源:`)
    if (Object.keys(stats.bySource).length > 0) {
      console.table(stats.bySource)
    } else {
      console.log('  (空)')
    }
    break
  }

  case 'dump': {
    const format = getFlag(args, '--format') || 'jsonl'
    if (format === 'md') {
      const entries = db.getTopMemories(500)
      if (entries.length === 0) {
        console.log('📭 暂无记忆条目')
        break
      }
      console.log('# Memory Dump\n')
      for (const e of entries) {
        console.log(`- **[${e.cat}]** (imp=${e.imp}, src=${e.source}) ${e.text}  _${e.updated_at}_`)
      }
      console.log(`\n---\n共 ${entries.length} 条记忆`)
    } else {
      const count = db.exportToJsonl('/dev/stdout')
      console.error(`\n导出了 ${count} 条记忆`)
    }
    break
  }

  case 'compact': {
    const beforeStats = db.getStats()
    const deleted = db.compact()
    const afterStats = db.getStats()
    console.log(`🗑️ Compact 完成:`)
    console.log(`  淘汰前: ${beforeStats.total} 条`)
    console.log(`  淘汰数: ${deleted} 条`)
    console.log(`  淘汰后: ${afterStats.total} 条`)
    break
  }

  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break

  default:
    if (command) {
      console.error(`❌ 未知命令: ${command}`)
    }
    printHelp()
    break
}
