import { FeishuService } from './feishu-service.js';
import type { FeishuConnectionConfig, FeishuMessage } from './types.js';
import { agentEngine } from '../../core/agent/index.js';
import type { EventHandlers } from '@/core/agent/types/agent.js';

export interface FeishuAgentBridgeConfig {
  feishu: FeishuConnectionConfig;
  // 每个飞书聊天对应的会话ID前缀
  sessionPrefix?: string;
  // 是否启用流式回复
  enableStreaming?: boolean;
  // 是否显示输入状态
  showTypingIndicator?: boolean;
}

export class FeishuAgentBridge {
  private feishuService: FeishuService;
  private config: FeishuAgentBridgeConfig;
  private chatToSessionMap = new Map<string, string>(); // 飞书聊天ID -> 会话ID
  private isConnected = false;

  constructor(config: FeishuAgentBridgeConfig) {
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
  async sendMessageToChat(chatId: string, text: string): Promise<void> {
    await this.feishuService.sendMessage(chatId, text);
  }

  /**
   * 获取会话统计信息
   */
  getSessionStats(): any {
    return {
      activeSessions: this.chatToSessionMap.size,
      isConnected: this.isBridgeConnected(),
      chatToSessionMap: Object.fromEntries(this.chatToSessionMap),
    };
  }

  /**
   * 处理飞书消息
   */
  private async handleFeishuMessage(message: FeishuMessage): Promise<void> {
    console.log(`📨 收到飞书消息: ${message.senderName} -> ${message.content.substring(0, 50)}...`);

    // 忽略空消息
    if (!message.content.trim()) {
      return;
    }

    // 获取或创建会话ID
    const sessionId = this.getOrCreateSessionId(message.chatId);

    // 显示输入状态（如果启用）
    if (this.config.showTypingIndicator) {
      await this.feishuService.sendTyping(message.chatId, true);
    }

    try {
      if (this.config.enableStreaming) {
        // 流式回复
        await this.handleStreamingResponse(sessionId, message);
      } else {
        // 非流式回复
        await this.handleRegularResponse(sessionId, message);
      }
    } catch (error) {
      console.error('处理飞书消息时出错:', error);
      await this.sendErrorResponse(message.chatId, error);
    } finally {
      // 隐藏输入状态
      if (this.config.showTypingIndicator) {
        await this.feishuService.sendTyping(message.chatId, false);
      }
    }
  }

  /**
   * 处理流式回复
   */
  private async handleStreamingResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    let fullResponse = '';

    const eventHandlers: EventHandlers = {
      onContentDelta: (textDelta: string) => {
        fullResponse += textDelta;
      },
      onContentStop: async () => {
        // 发送最终回复
        if (fullResponse) {
          await this.feishuService.sendMessage(message.chatId, fullResponse);
          console.log(`✅ 流式回复完成: ${fullResponse.length} 字符`);
        }
      },
      onError: (error: string) => {
        console.error('流式回复错误:', error);
        this.sendErrorResponse(message.chatId, new Error(error)).catch(console.error);
      },
    };

    // 发送消息，并传递事件处理器
    await agentEngine.sendMessageStream(sessionId, message.content, message.senderId, eventHandlers);
  }

  /**
   * 处理常规回复
   */
  private async handleRegularResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    const response = await agentEngine.sendMessage(sessionId, message.content, message.senderId);

    if (response && response.content) {
      await this.feishuService.sendMessage(message.chatId, response.content);
      console.log(`✅ 常规回复完成: ${response.content.length} 字符`);
    } else {
      await this.sendErrorResponse(message.chatId, new Error('Agent返回空回复'));
    }
  }


  /**
   * 发送错误回复
   */
  private async sendErrorResponse(chatId: string, error: any): Promise<void> {
    const errorMessage = `抱歉，处理消息时出现了错误：\n\n${error instanceof Error ? error.message : '未知错误'}`;
    await this.feishuService.sendMessage(chatId, errorMessage);
  }

  /**
   * 获取或创建会话ID
   */
  private getOrCreateSessionId(chatId: string): string {
    if (this.chatToSessionMap.has(chatId)) {
      return this.chatToSessionMap.get(chatId)!;
    }

    const sessionId = `${this.config.sessionPrefix}${chatId}`;
    this.chatToSessionMap.set(chatId, sessionId);

    // 创建新会话
    agentEngine.createSession({
      sessionId,
      userId: chatId, // 使用chatId作为用户ID
    });

    console.log(`🆕 创建新会话: ${sessionId}`);
    return sessionId;
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