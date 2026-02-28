// 记忆管理器

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MemorySource,
  MemoryFilePayload,
  MemoryScope,
  MemoryKind,
  MemoryConfig,
  MEMORY_SOURCE_EXTENSIONS,
} from './types.js';

// 默认配置
const DEFAULT_CONFIG: MemoryConfig = {
  basePath: process.env.MEMORY_BASE_PATH || './data',
  maxGlobalMemoryLength: 200_000,
  maxMemoryFileLength: 500_000,
  memoryListLimit: 500,
  memorySearchLimit: 120,
};

// 记忆路径中禁止写入的系统子目录
const MEMORY_BLOCKED_DIRS = ['logs', '.claude', 'conversations'];

export class MemoryManager {
  private config: MemoryConfig;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- 路径处理工具函数 ---

  private isWithinRoot(targetPath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  private normalizeRelativePath(input: string): string {
    const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (!normalized || normalized.includes('\0')) {
      throw new Error('Invalid memory path');
    }
    const parts = normalized.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) {
      throw new Error('Invalid memory path');
    }
    return normalized;
  }

  private resolveMemoryPath(relativePath: string): {
    absolutePath: string;
    writable: boolean;
  } {
    const normalized = this.normalizeRelativePath(relativePath);
    const absolute = path.resolve(this.config.basePath, normalized);

    // 检查是否在允许的路径范围内
    const inMemoryData = this.isWithinRoot(absolute, path.join(this.config.basePath, 'memory'));
    const inSessions = this.isWithinRoot(absolute, path.join(this.config.basePath, 'sessions'));
    const writable = inMemoryData || inSessions;  // 允许写入memory和sessions目录
    const readable = writable || inSessions;

    if (!readable) {
      throw new Error('Memory path out of allowed scope');
    }

    return { absolutePath: absolute, writable };
  }

  private isBlockedMemoryPath(normalizedPath: string): boolean {
    const parts = normalizedPath.split('/');
    // 检查 memory/{folder}/ 下的系统子目录
    if (parts[0] === 'memory' && parts.length >= 2) {
      const subPath = parts[1];
      if (MEMORY_BLOCKED_DIRS.includes(subPath)) return true;
    }
    return false;
  }

  // --- 记忆源分类 ---

  private classifyMemorySource(relativePath: string): Pick<MemorySource, 'scope' | 'kind' | 'label'> {
    const parts = relativePath.split('/');

    // memory/user-global/CLAUDE.md
    if (parts[0] === 'memory' && parts[1] === 'user-global') {
      const name = parts.slice(2).join('/') || 'CLAUDE.md';
      return {
        scope: 'user-global',
        kind: 'claude',
        label: `用户全局记忆 / ${name}`,
      };
    }

    // memory/project/CLAUDE.md
    if (parts[0] === 'memory' && parts[1] === 'project') {
      const name = parts.slice(2).join('/') || 'CLAUDE.md';
      return {
        scope: 'project',
        kind: 'claude',
        label: `项目记忆 / ${name}`,
      };
    }

    // memory/{folder}/...
    if (parts[0] === 'memory') {
      const folder = parts[1] || 'unknown';
      const name = parts.slice(2).join('/') || 'memory';
      return {
        scope: folder === 'project' ? 'project' : 'user-global',
        kind: 'note',
        label: `${folder} / 记忆 / ${name}`,
      };
    }

    // sessions/{sessionId}/...
    if (parts[0] === 'sessions') {
      const sessionRel = parts.slice(1).join('/');
      return {
        scope: 'session',
        kind: 'session',
        label: `会话记忆 / ${sessionRel}`,
      };
    }

    // 默认分类
    return {
      scope: 'session',
      kind: 'note',
      label: `未知记忆 / ${relativePath}`,
    };
  }

  // --- 文件操作 ---

  public readMemoryFile(relativePath: string): MemoryFilePayload {
    const normalized = this.normalizeRelativePath(relativePath);
    const { absolutePath, writable } = this.resolveMemoryPath(normalized);

    if (!fs.existsSync(absolutePath)) {
      if (!writable) {
        throw new Error('Memory file not found');
      }
      return {
        path: normalized,
        content: '',
        updatedAt: null,
        size: 0,
        writable,
      };
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const stat = fs.statSync(absolutePath);
    return {
      path: normalized,
      content,
      updatedAt: stat.mtime.toISOString(),
      size: Buffer.byteLength(content, 'utf-8'),
      writable,
    };
  }

  public writeMemoryFile(relativePath: string, content: string): MemoryFilePayload {
    const normalized = this.normalizeRelativePath(relativePath);
    const { absolutePath, writable } = this.resolveMemoryPath(normalized);

    if (!writable) {
      throw new Error('Memory file is read-only');
    }

    if (this.isBlockedMemoryPath(normalized)) {
      throw new Error('Cannot write to system path');
    }

    if (Buffer.byteLength(content, 'utf-8') > this.config.maxMemoryFileLength) {
      throw new Error('Memory file is too large');
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, absolutePath);

    const stat = fs.statSync(absolutePath);
    return {
      path: normalized,
      content,
      updatedAt: stat.mtime.toISOString(),
      size: Buffer.byteLength(content, 'utf-8'),
      writable,
    };
  }

  // --- 记忆源列表 ---

  private walkFiles(baseDir: string, maxDepth: number, limit: number, out: string[], currentDepth = 0): void {
    if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir)) return;

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) break;
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        this.walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
        continue;
      }
      out.push(fullPath);
    }
  }

  private isMemoryCandidateFile(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    if (base === 'settings.json') return true;
    const ext = path.extname(base);
    return MEMORY_SOURCE_EXTENSIONS.has(ext);
  }

  public listMemorySources(): MemorySource[] {
    const files = new Set<string>();
    const memoryDir = path.join(this.config.basePath, 'memory');
    const sessionsDir = path.join(this.config.basePath, 'sessions');

    // 1. 用户全局记忆
    const userGlobalPath = path.join(memoryDir, 'user-global', 'CLAUDE.md');
    files.add(userGlobalPath);

    // 2. 项目记忆
    const projectPath = path.join(memoryDir, 'project', 'CLAUDE.md');
    files.add(projectPath);

    // 3. 扫描memory目录
    if (fs.existsSync(memoryDir)) {
      const scanned: string[] = [];
      this.walkFiles(memoryDir, 4, this.config.memoryListLimit, scanned);
      for (const f of scanned) {
        if (this.isMemoryCandidateFile(f)) files.add(f);
      }
    }

    // 4. 扫描sessions目录
    if (fs.existsSync(sessionsDir)) {
      const scanned: string[] = [];
      this.walkFiles(sessionsDir, 7, this.config.memoryListLimit, scanned);
      for (const f of scanned) {
        if (this.isMemoryCandidateFile(f)) files.add(f);
      }
    }

    const sources: MemorySource[] = [];
    for (const absolutePath of files) {
      const relativePath = path
        .relative(this.config.basePath, absolutePath)
        .replace(/\\/g, '/');

      const writable = this.isWithinRoot(absolutePath, memoryDir);
      const exists = fs.existsSync(absolutePath);
      let updatedAt: string | null = null;
      let size = 0;

      if (exists) {
        const stat = fs.statSync(absolutePath);
        updatedAt = stat.mtime.toISOString();
        size = stat.size;
      }

      const classified = this.classifyMemorySource(relativePath);
      sources.push({
        path: relativePath,
        writable,
        exists,
        updatedAt,
        size,
        ...classified,
      });
    }

    // 排序：user-global > project > session
    const scopeRank: Record<MemoryScope, number> = {
      'user-global': 0,
      'project': 1,
      'session': 2,
    };

    const kindRank: Record<MemoryKind, number> = {
      'claude': 0,
      'note': 1,
      'session': 2,
    };

    sources.sort((a, b) => {
      if (scopeRank[a.scope] !== scopeRank[b.scope])
        return scopeRank[a.scope] - scopeRank[b.scope];
      if (kindRank[a.kind] !== kindRank[b.kind])
        return kindRank[a.kind] - kindRank[b.kind];
      return a.path.localeCompare(b.path, 'zh-CN');
    });

    return sources.slice(0, this.config.memoryListLimit);
  }

  // --- 工具函数 ---

  public getConfig(): MemoryConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}