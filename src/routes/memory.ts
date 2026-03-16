/**
 * 记忆管理路由 V4.1
 * 新增 SQLite MemoryDB 路由，保留旧文件路由向后兼容
 */

import { Hono } from 'hono';
import { getAgentEngine } from '../core/agent-registry.js';

const memoryRoutes = new Hono();

// ==================== V5.0 路由：MemoryDB (Markdown) ====================

// 搜索记忆（关键词）
memoryRoutes.get('/v2/search', (c) => {
  const query = c.req.query('q');
  const limitRaw = Number(c.req.query('limit'));
  const cat = c.req.query('cat');

  if (!query || !query.trim()) {
    return c.json({ error: 'Missing search query' }, 400);
  }

  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;

  try {
    const memoryDb = getAgentEngine().getMemoryDb();
    let results = memoryDb.search(query, limit);
    if (cat) {
      results = results.filter(r => r.cat === cat);
    }
    return c.json({ results, total: results.length });
  } catch (err) {
    console.error('Failed to search memories:', err);
    return c.json({ error: 'Failed to search memories' }, 500);
  }
});

// 获取记忆统计
memoryRoutes.get('/v2/stats', (c) => {
  try {
    const memoryDb = getAgentEngine().getMemoryDb();
    const stats = memoryDb.getStats();
    return c.json(stats);
  } catch (err) {
    console.error('Failed to get memory stats:', err);
    return c.json({ error: 'Failed to get memory stats' }, 500);
  }
});

// 列出记忆
memoryRoutes.get('/v2/list', (c) => {
  const cat = c.req.query('cat');
  const source = c.req.query('source');
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

  try {
    const memoryDb = getAgentEngine().getMemoryDb();
    let entries;
    if (cat) {
      entries = memoryDb.getByCategory(cat, limit);
    } else if (source) {
      entries = memoryDb.getBySource(source, limit);
    } else {
      entries = memoryDb.getTopMemories(limit);
    }
    return c.json({ entries, total: entries.length });
  } catch (err) {
    console.error('Failed to list memories:', err);
    return c.json({ error: 'Failed to list memories' }, 500);
  }
});

// 添加记忆
memoryRoutes.post('/v2/add', async (c) => {
  try {
    const body = await c.req.json();
    const { text, cat, imp, source, keywords } = body;

    if (!text || !cat || imp === undefined || !keywords) {
      return c.json({ error: 'Missing required fields: text, cat, imp, keywords' }, 400);
    }

    const memoryDb = getAgentEngine().getMemoryDb();
    const result = memoryDb.insert({ text, cat, imp, source: source || 'USER', keywords: body.keywords || [] });
    return c.json({ result, message: `Memory ${result}` });
  } catch (err) {
    console.error('Failed to add memory:', err);
    return c.json({ error: 'Failed to add memory' }, 500);
  }
});

// 删除记忆
memoryRoutes.delete('/v2/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid memory ID' }, 400);
  }

  try {
    const memoryDb = getAgentEngine().getMemoryDb();
    memoryDb.deleteById(id);
    return c.json({ success: true, message: `Memory ${id} deleted` });
  } catch (err) {
    console.error('Failed to delete memory:', err);
    return c.json({ error: 'Failed to delete memory' }, 500);
  }
});

// 手动触发淘汰
memoryRoutes.post('/v2/compact', (c) => {
  try {
    const memoryDb = getAgentEngine().getMemoryDb();
    const deleted = memoryDb.compact();
    return c.json({ deleted, message: `Compacted: ${deleted} entries removed` });
  } catch (err) {
    console.error('Failed to compact memories:', err);
    return c.json({ error: 'Failed to compact memories' }, 500);
  }
});

// ==================== 对话历史路由 ====================

// 列出所有会话
memoryRoutes.get('/v2/sessions', (c) => {
  try {
    const store = getAgentEngine().getConversationStore();
    const sessions = store.listSessions();
    return c.json({ sessions, total: sessions.length });
  } catch (err) {
    console.error('Failed to list sessions:', err);
    return c.json({ error: 'Failed to list sessions' }, 500);
  }
});

// 获取会话对话历史
memoryRoutes.get('/v2/sessions/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

  try {
    const store = getAgentEngine().getConversationStore();
    const entries = store.loadRecent(sessionId, limit);
    return c.json({ entries, total: entries.length });
  } catch (err) {
    console.error('Failed to get session history:', err);
    return c.json({ error: 'Failed to get session history' }, 500);
  }
});

export default memoryRoutes;
