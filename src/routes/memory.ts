// 记忆管理路由

import { Hono } from 'hono';
import { z } from 'zod';
import { MemoryManager } from '../core/memory/memory-manager.js';
import { MemorySearcher } from '../core/memory/memory-searcher.js';

const memoryRoutes = new Hono();
const memoryManager = new MemoryManager();
const memorySearcher = new MemorySearcher(memoryManager);

// 请求验证模式
const MemoryFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const MemoryGlobalSchema = z.object({
  content: z.string(),
});

const MemorySearchSchema = z.object({
  q: z.string().min(1),
  limit: z.number().min(1).max(200).optional(),
  scope: z.enum(['session', 'user-global', 'project']).optional(),
});

// --- 路由实现 ---

// 获取记忆源列表
memoryRoutes.get('/sources', (c) => {
  try {
    const sources = memoryManager.listMemorySources();
    return c.json({ sources });
  } catch (err) {
    console.error('Failed to list memory sources:', err);
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

// 搜索记忆
memoryRoutes.get('/search', (c) => {
  const query = c.req.query('q');
  const limitRaw = Number(c.req.query('limit'));
  const scope = c.req.query('scope') as any;

  if (!query || !query.trim()) {
    return c.json({ error: 'Missing search query' }, 400);
  }

  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

  try {
    const hits = memorySearcher.searchMemorySources({
      keyword: query,
      limit,
      scope,
    });
    return c.json({ hits });
  } catch (err) {
    console.error('Failed to search memory sources:', err);
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

// 高级搜索
memoryRoutes.post('/search/advanced', async (c) => {
  try {
    const body = await c.req.json();
    const { keywords, operator, scope, limit } = body;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return c.json({ error: 'Missing or invalid keywords' }, 400);
    }

    const hits = await memorySearcher.advancedSearch({
      keywords,
      operator: operator || 'AND',
      scope,
      limit,
    });

    return c.json({ hits });
  } catch (err) {
    console.error('Failed to perform advanced search:', err);
    return c.json({ error: 'Failed to perform advanced search' }, 500);
  }
});

// 读取记忆文件
memoryRoutes.get('/file', (c) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'Missing file path' }, 400);
  }

  try {
    const payload = memoryManager.readMemoryFile(filePath);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

// 写入记忆文件
memoryRoutes.put('/file', async (c) => {
  try {
    const body = await c.req.json();
    const validation = MemoryFileSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const { path: filePath, content } = validation.data;
    const payload = memoryManager.writeMemoryFile(filePath, content);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// 获取用户全局记忆
memoryRoutes.get('/global', (c) => {
  try {
    const userGlobalPath = 'memory/user-global/CLAUDE.md';
    const payload = memoryManager.readMemoryFile(userGlobalPath);
    return c.json(payload);
  } catch (err) {
    console.error('Failed to read user global memory:', err);
    return c.json({ error: 'Failed to read global memory' }, 500);
  }
});

// 更新用户全局记忆
memoryRoutes.put('/global', async (c) => {
  try {
    const body = await c.req.json();
    const validation = MemoryGlobalSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const { content } = validation.data;
    const config = memoryManager.getConfig();

    if (Buffer.byteLength(content, 'utf-8') > config.maxGlobalMemoryLength) {
      return c.json({ error: 'Global memory is too large' }, 400);
    }

    const userGlobalPath = 'memory/user-global/CLAUDE.md';
    const payload = memoryManager.writeMemoryFile(userGlobalPath, content);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write global memory';
    console.error('Failed to write user global memory:', err);
    return c.json({ error: message }, 400);
  }
});

// 获取项目记忆
memoryRoutes.get('/project', (c) => {
  try {
    const projectPath = 'memory/project/CLAUDE.md';
    const payload = memoryManager.readMemoryFile(projectPath);
    return c.json(payload);
  } catch (err) {
    console.error('Failed to read project memory:', err);
    return c.json({ error: 'Failed to read project memory' }, 500);
  }
});

// 更新项目记忆
memoryRoutes.put('/project', async (c) => {
  try {
    const body = await c.req.json();
    const validation = MemoryFileSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const { content } = validation.data;
    const projectPath = 'memory/project/CLAUDE.md';
    const payload = memoryManager.writeMemoryFile(projectPath, content);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write project memory';
    console.error('Failed to write project memory:', err);
    return c.json({ error: message }, 400);
  }
});

// 获取会话记忆
memoryRoutes.get('/session/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) {
    return c.json({ error: 'Missing session ID' }, 400);
  }

  try {
    const sessionPath = `sessions/${sessionId}/CLAUDE.md`;
    const payload = memoryManager.readMemoryFile(sessionPath);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read session memory';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

// 更新会话记忆
memoryRoutes.put('/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!sessionId) {
    return c.json({ error: 'Missing session ID' }, 400);
  }

  try {
    const body = await c.req.json();
    const validation = MemoryFileSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const { content } = validation.data;
    const sessionPath = `sessions/${sessionId}/CLAUDE.md`;
    const payload = memoryManager.writeMemoryFile(sessionPath, content);
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write session memory';
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;