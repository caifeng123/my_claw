/**
 * FeishuAgentBridge V4.1
 * 简化版：去掉手动拼历史逻辑，由 AgentEngine 内部管理上下文
 */

import { FeishuService } from './feishu-service.js';
import type { FeishuConnectionConfig, FeishuMessage, ThreadContext } from './types.js';
import { agentEngine } from '../../core/agent/index.js';
import type { EventHandlers } from '@/core/agent/types/agent.js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { ClaudeEngine } from '@/core/agent/engine/claude-engine.js';

// 状态文件路径
const STATE_FILE = '.restart-state.json';

// 重启状态接口
interface RestartState {
  chatIds: string[];
  messageIds: string[];
  status: 'restarting' | 'rollback' | 'success';
  timestamp: number;
  error?: string;
  hasConflict?: boolean;
  commitMessage?: string;
}

export interface FeishuAgentBridgeConfig {
  feishu: FeishuConnectionConfig;
  sessionPrefix?: string;
  enableStreaming?: boolean;
  showTypingIndicator?: boolean;
}

export class FeishuAgentBridge {
  private feishuService: FeishuService;
  private config: FeishuAgentBridgeConfig;
  private claudeEngine: ClaudeEngine;
  private chatToSessionMap = new Map<string, string>();
  private threadContexts = new Map<string, ThreadContext>();
  private isConnected = false;
  private processingChats = new Set<string>();

  constructor(config: FeishuAgentBridgeConfig) {
    this.claudeEngine = new ClaudeEngine()
    this.config = {
      sessionPrefix: 'feishu_',
      enableStreaming: true,
      showTypingIndicator: true,
      ...config,
    };

    this.feishuService = new FeishuService(config.feishu);
  }

  /**
   * 启动飞书Agent桥接服务
   */
  async start(): Promise<boolean> {
    console.log('🚀 启动飞书Agent桥接服务...');

    const success = await this.feishuService.connect((message) => {
      this.handleFeishuMessage(message);
    });

    if (success) {
      this.isConnected = true;
      console.log('✅ 飞书Agent桥接服务启动成功');
    } else {
      console.error('❌ 飞书Agent桥接服务启动失败');
    }

    return success;
  }

  /**
   * 停止飞书Agent桥接服务
   */
  async stop(): Promise<void> {
    console.log('🛑 停止飞书Agent桥接服务...');
    await this.feishuService.disconnect();
    this.isConnected = false;
    this.chatToSessionMap.clear();
    this.threadContexts.clear();
    console.log('✅ 飞书Agent桥接服务已停止');
  }

  /**
   * 检查服务是否已连接
   */
  isBridgeConnected(): boolean {
    return this.isConnected && this.feishuService.isConnected();
  }

  /**
   * 手动发送消息到飞书聊天
   */
  async sendMessageToChat(chatId: string, text: string, replyMessageId?: string, threadId?: string): Promise<void> {
    await this.feishuService.sendMessage(chatId, text, replyMessageId, threadId);
  }

  /**
   * 处理 /restart 指令
   */
  private async handleRestartCommand(message: FeishuMessage): Promise<void> {
    console.log('🔄 收到 /restart 指令');

    await this.feishuService.sendMessage(
      message.chatId,
      '🔄 收到重启指令，正在分析代码变更...',
      message.messageId,
      message.threadId
    );

    let commitMessage = 'auto: verified restart commit';
    try {
      const diff = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8' }).trim();
      const summary = [diff, untracked ? `新增文件:\n${untracked}` : ''].filter(Boolean).join('\n\n');

      if (summary) {
        const result = await this.claudeEngine.executeClaudeQueryRaw(
          '你是一个专业的 Git 提交消息生成器。根据代码变更，生成一个简洁的、符合 Git 提交规范的 commit message。只返回 commit message 本身，不要包含其他说明。',
          `请根据以下代码变更生成一个简洁的 commit message:\n\n${summary}`,
        );
        commitMessage = result.result.trim()
        console.log(`📝 生成的 commit message: ${commitMessage}`);
      }
    } catch (e) {
      console.warn('⚠️ 生成 commit message 失败，使用默认值:', e);
    }

    await this.feishuService.sendMessage(
      message.chatId,
      `📝 变更摘要：${commitMessage}\n\n🚀 正在重启服务，请稍候...`,
      message.messageId,
      message.threadId
    );

    const state: RestartState = {
      chatIds: [message.chatId],
      messageIds: [message.messageId],
      status: 'restarting',
      timestamp: Date.now(),
      commitMessage,
    };

    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log('📄 状态文件已写入');
    } catch (error) {
      console.error('❌ 写入状态文件失败:', error);
    }

    if (process.send) {
      process.send({ type: 'restart' });
      console.log('📤 已发送重启请求给 Launcher');
    } else {
      console.warn('⚠️ 未检测到 Launcher，直接退出');
      setTimeout(() => process.exit(0), 500);
    }
  }

  /**
   * 获取会话统计信息
   */
  getSessionStats(): any {
    return {
      activeSessions: this.chatToSessionMap.size,
      activeThreads: this.threadContexts.size,
      isConnected: this.isBridgeConnected(),
      chatToSessionMap: Object.fromEntries(this.chatToSessionMap),
      threadContexts: Object.fromEntries(this.threadContexts),
    };
  }

  /**
   * 处理飞书消息
   * V4.1: 不再手动拼历史，直接委托 AgentEngine 处理
   * AgentEngine 内部通过 ConversationStore + ContextBuilder 智能管理上下文
   */
  private async handleFeishuMessage(message: FeishuMessage): Promise<void> {
    console.log(`📨 Received Feishu message: ${message.senderName} -> ${message.content.substring(0, 50)}...`);

    if (!message.content.trim()) {
      return;
    }

    const trimmedContent = message.content.trim();
    if (trimmedContent === '/restart') {
      await this.handleRestartCommand(message);
      return;
    }

    const processingKey = message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;

    if (this.processingChats.has(processingKey)) {
      console.log(`⏳ Chat ${processingKey} is busy, waiting for previous message to complete...`);
      await this.waitForProcessingComplete(processingKey);
    }

    this.processingChats.add(processingKey);

    try {
      const sessionId = this.getOrCreateSessionId(message.chatId, message.threadId);

      if (message.threadId) {
        this.updateThreadActivity(message.threadId, message.chatId);
      }

      if (this.config.showTypingIndicator) {
        await this.feishuService.sendTyping(message.chatId, true, message.threadId);
      }

      try {
        if (this.config.enableStreaming) {
          await this.handleStreamingResponse(sessionId, message);
        } else {
          await this.handleRegularResponse(sessionId, message);
        }
      } catch (error) {
        console.error('Error processing Feishu message:', error);
        await this.sendErrorResponse(message.chatId, error, message.messageId, message.threadId);
      } finally {
        if (this.config.showTypingIndicator) {
          await this.feishuService.sendTyping(message.chatId, false, message.threadId);
        }
      }
    } finally {
      this.processingChats.delete(processingKey);
    }
  }

  /**
   * 等待指定聊天的处理完成
   */
  private async waitForProcessingComplete(processingKey: string): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.processingChats.has(processingKey)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 30000);
    });
  }

  /**
   * 处理流式回复
   * V4.1: 直接传消息内容，AgentEngine 内部处理上下文构建
   */
  private async handleStreamingResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    let fullResponse = '';

    const replyMessageId = message.threadId ? message.messageId : undefined;

    const eventHandlers: EventHandlers = {
      onContentDelta: async (textDelta: string) => {
        fullResponse += textDelta;
      },
      onContentStop: async () => {
        if (fullResponse) {
          await this.feishuService.sendMessage(message.chatId, fullResponse, replyMessageId, message.threadId);
          console.log(`✅ Streaming response completed: ${fullResponse.length} chars`);
        }
      },
      onError: async (error: string) => {
        console.error('Streaming response error:', error);
        this.sendErrorResponse(message.chatId, new Error(error), replyMessageId, message.threadId).catch(console.error);
      },
    };

    // V4.1: agentEngine.sendMessageStream 内部自动处理上下文构建（FTS5 记忆检索 + 对话压缩）
    await agentEngine.sendMessageStream(sessionId, message.content, message.senderId, eventHandlers);
  }

  /**
   * 处理常规回复
   * V4.1: 直接传消息内容，AgentEngine 内部处理上下文构建
   */
  private async handleRegularResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    // V4.1: agentEngine.sendMessage 内部自动处理上下文构建
    const response = await agentEngine.sendMessage(sessionId, message.content, message.senderId);

    const replyMessageId = message.threadId ? message.messageId : undefined;

    if (response && response.content) {
      await this.feishuService.sendMessage(message.chatId, response.content, replyMessageId, message.threadId);
      console.log(`✅ Regular response completed: ${response.content.length} chars`);
    } else {
      await this.sendErrorResponse(message.chatId, new Error('Agent returned empty response'), replyMessageId, message.threadId);
    }
  }

  /**
   * 发送错误回复
   */
  private async sendErrorResponse(chatId: string, error: any, replyMessageId?: string, threadId?: string): Promise<void> {
    const errorMessage = `抱歉，处理消息时出现了错误：\n\n${error instanceof Error ? error.message : '未知错误'}`;
    await this.feishuService.sendMessage(chatId, errorMessage, replyMessageId, threadId);
  }

  /**
   * 获取或创建会话ID
   */
  private getOrCreateSessionId(chatId: string, threadId?: string): string {
    const sessionKey = threadId ? `${chatId}:${threadId}` : chatId;

    if (this.chatToSessionMap.has(sessionKey)) {
      return this.chatToSessionMap.get(sessionKey)!;
    }

    const sessionId = threadId
      ? `${this.config.sessionPrefix}${chatId}_${threadId}`
      : `${this.config.sessionPrefix}${chatId}`;

    this.chatToSessionMap.set(sessionKey, sessionId);

    // 创建新会话（AgentEngine 内部会恢复已有历史）
    agentEngine.createSession({
      sessionId,
      userId: chatId,
    });

    console.log(`🆕 Created new ${threadId ? 'thread' : 'chat'} session: ${sessionId}`);
    return sessionId;
  }

  /**
   * 更新线程活动状态
   */
  private updateThreadActivity(threadId: string, chatId: string): void {
    const contextKey = `${chatId}:${threadId}`;
    const context: ThreadContext = {
      threadId,
      chatId,
      sessionId: this.getOrCreateSessionId(chatId, threadId),
      lastActivityAt: Date.now(),
      messageCount: (this.threadContexts.get(contextKey)?.messageCount || 0) + 1,
    };
    this.threadContexts.set(contextKey, context);
  }
}

/**
 * 创建默认的飞书Agent桥接实例
 */
export function createFeishuAgentBridge(config: FeishuAgentBridgeConfig): FeishuAgentBridge {
  return new FeishuAgentBridge(config);
}

/**
 * 全局默认实例（单例模式）
 */
let defaultBridge: FeishuAgentBridge | null = null;

export function getDefaultFeishuAgentBridge(config?: FeishuAgentBridgeConfig): FeishuAgentBridge {
  if (!defaultBridge && config) {
    defaultBridge = createFeishuAgentBridge(config);
  }
  return defaultBridge!;
}

export async function startDefaultFeishuBridge(config: FeishuAgentBridgeConfig): Promise<boolean> {
  const bridge = getDefaultFeishuAgentBridge(config);
  return await bridge.start();
}

export async function stopDefaultFeishuBridge(): Promise<void> {
  if (defaultBridge) {
    await defaultBridge.stop();
    defaultBridge = null;
  }
}
