// 记忆搜索器

import { MemoryManager } from './memory-manager.js';
import type { MemorySearchHit, MemorySearchOptions } from './types.js';

export class MemorySearcher {
  private memoryManager: MemoryManager;

  constructor(memoryManager: MemoryManager) {
    this.memoryManager = memoryManager;
  }

  // 构建搜索片段
  private buildSearchSnippet(content: string, index: number, keywordLength: number): string {
    const start = Math.max(0, index - 36);
    const end = Math.min(content.length, index + keywordLength + 36);
    return content.slice(start, end).replace(/\s+/g, ' ').trim();
  }

  // 搜索记忆源
  public async searchMemorySources(options: MemorySearchOptions): Promise<MemorySearchHit[]> {
    const { keyword, limit, scope } = options;
    const normalizedKeyword = keyword.trim().toLowerCase();

    if (!normalizedKeyword) return [];

    const maxResults = limit && Number.isFinite(limit)
      ? Math.max(1, Math.min(this.memoryManager.getConfig().memorySearchLimit, Math.trunc(limit)))
      : this.memoryManager.getConfig().memorySearchLimit;

    const hits: MemorySearchHit[] = [];
    const sources = this.memoryManager.listMemorySources();

    for (const source of sources) {
      if (hits.length >= maxResults) break;

      // 按范围过滤
      if (scope && source.scope !== scope) continue;

      if (!source.exists || source.size === 0) continue;
      if (source.size > this.memoryManager.getConfig().maxMemoryFileLength) continue;

      try {
        const payload = this.memoryManager.readMemoryFile(source.path);
        const lower = payload.content.toLowerCase();
        const firstIndex = lower.indexOf(normalizedKeyword);

        if (firstIndex === -1) continue;

        // 计算命中次数
        let count = 0;
        let from = 0;
        while (from < lower.length) {
          const idx = lower.indexOf(normalizedKeyword, from);
          if (idx === -1) break;
          count += 1;
          from = idx + normalizedKeyword.length;
        }

        hits.push({
          ...source,
          hits: count,
          snippet: this.buildSearchSnippet(payload.content, firstIndex, normalizedKeyword.length),
        });
      } catch {
        continue;
      }
    }

    // 按命中次数排序
    hits.sort((a, b) => b.hits - a.hits);

    return hits;
  }

  // 高级搜索：支持多关键词和模糊匹配
  public async advancedSearch(options: {
    keywords: string[];
    operator?: 'AND' | 'OR';
    scope?: MemorySearchOptions['scope'];
    limit?: number;
  }): Promise<MemorySearchHit[]> {
    const { keywords, operator = 'AND', scope, limit } = options;

    if (keywords.length === 0) return [];

    const normalizedKeywords = keywords.map(k => k.trim().toLowerCase()).filter(k => k);
    if (normalizedKeywords.length === 0) return [];

    const maxResults = limit && Number.isFinite(limit)
      ? Math.max(1, Math.min(this.memoryManager.getConfig().memorySearchLimit, Math.trunc(limit)))
      : this.memoryManager.getConfig().memorySearchLimit;

    const hits: MemorySearchHit[] = [];
    const sources = this.memoryManager.listMemorySources();

    for (const source of sources) {
      if (hits.length >= maxResults) break;

      if (scope && source.scope !== scope) continue;
      if (!source.exists || source.size === 0) continue;
      if (source.size > this.memoryManager.getConfig().maxMemoryFileLength) continue;

      try {
        const payload = this.memoryManager.readMemoryFile(source.path);
        const content = payload.content.toLowerCase();

        let matches = false;
        let totalHits = 0;
        let firstIndex = -1;

        if (operator === 'AND') {
          // 所有关键词都必须匹配
          matches = normalizedKeywords.every(keyword => content.includes(keyword));
          if (matches) {
            normalizedKeywords.forEach(keyword => {
              let from = 0;
              while (from < content.length) {
                const idx = content.indexOf(keyword, from);
                if (idx === -1) break;
                totalHits += 1;
                from = idx + keyword.length;
                if (firstIndex === -1 || idx < firstIndex) {
                  firstIndex = idx;
                }
              }
            });
          }
        } else {
          // OR 操作符：任意关键词匹配
          normalizedKeywords.forEach(keyword => {
            let from = 0;
            while (from < content.length) {
              const idx = content.indexOf(keyword, from);
              if (idx === -1) break;
              totalHits += 1;
              from = idx + keyword.length;
              if (firstIndex === -1 || idx < firstIndex) {
                firstIndex = idx;
              }
              matches = true;
            }
          });
        }

        if (matches && firstIndex !== -1) {
          // 使用第一个匹配的关键词构建片段
          const firstKeyword = normalizedKeywords.find(k => content.includes(k)) || normalizedKeywords[0];
          hits.push({
            ...source,
            hits: totalHits,
            snippet: this.buildSearchSnippet(payload.content, firstIndex, firstKeyword.length),
          });
        }
      } catch {
        continue;
      }
    }

    // 按命中次数排序
    hits.sort((a, b) => b.hits - a.hits);

    return hits;
  }

  // 获取特定范围的记忆源
  public getMemoryByScope(scope: MemorySearchOptions['scope']): MemorySearchHit[] {
    const sources = this.memoryManager.listMemorySources();
    const filtered = scope ? sources.filter(s => s.scope === scope) : sources;

    return filtered.map(source => ({
      ...source,
      hits: 0,
      snippet: '',
    }));
  }
}