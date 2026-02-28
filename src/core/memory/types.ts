// 记忆系统类型定义

export type MemoryScope = 'session' | 'user-global' | 'project';
export type MemoryKind = 'claude' | 'note' | 'session';

export interface MemorySource {
  path: string;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  scope: MemoryScope;
  kind: MemoryKind;
  label: string;
  ownerName?: string;
}

export interface MemoryFilePayload {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

export interface MemorySearchHit {
  path: string;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  scope: MemoryScope;
  kind: MemoryKind;
  label: string;
  ownerName?: string;
  hits: number;
  snippet: string;
}

export interface MemoryConfig {
  basePath: string;
  maxGlobalMemoryLength: number;
  maxMemoryFileLength: number;
  memoryListLimit: number;
  memorySearchLimit: number;
}

export interface MemorySearchOptions {
  keyword: string;
  limit?: number;
  scope?: MemoryScope;
}

export interface MemoryWriteOptions {
  content: string;
  overwrite?: boolean;
}

export const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);