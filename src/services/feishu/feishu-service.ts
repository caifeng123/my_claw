import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuConnection, FeishuConnectionConfig, FeishuMessage } from './types.js';

// 飞书消息类型
const MESSAGE_TYPE_TEXT = 'text';
const MESSAGE_TYPE_POST = 'post';
const MESSAGE_TYPE_IMAGE = 'image';

// 消息类型选择阈值
const PLAIN_TEXT_LIMIT = 200; // 少于200字符使用纯文本
const CARD_MD_LIMIT = 4000; // 卡片消息限制
const TEXT_MSG_LIMIT = 2048; // 飞书纯文本消息限制

// 消息去重缓存设置
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30分钟

export class FeishuService implements FeishuConnection {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private config: FeishuConnectionConfig;
  private onMessageCallback: ((message: FeishuMessage) => void) | null = null;
  private messageCache = new Map<string, number>();
  private lastMessageIdByChat = new Map<string, string>();
  private ackReactionByChat = new Map<string, string>(); // 消息确认反应
  private typingReactionByChat = new Map<string, string>(); // 输入状态反应

  constructor(config: FeishuConnectionConfig) {
    this.config = config;
  }

  async connect(onMessage: (message: FeishuMessage) => void): Promise<boolean> {
    this.onMessageCallback = onMessage;

    if (!this.config.appId || !this.config.appSecret) {
      console.warn('Feishu config is empty, skipping connection');
      return false;
    }

    try {
      // 初始化客户端
      this.client = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // 创建事件分发器
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.handleMessage(data);
        },
      });

      // 初始化 WebSocket 客户端
      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      await this.wsClient.start({ eventDispatcher });
      console.log('Feishu WebSocket client started successfully');
      return true;
    } catch (error) {
      console.error('Failed to start Feishu client:', error);
      this.client = null;
      this.wsClient = null;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        await this.wsClient.close();
        console.log('Feishu client disconnected');
      } catch (error) {
        console.warn('Error disconnecting Feishu client:', error);
      }
      this.wsClient = null;
    }
    this.client = null;
    this.onMessageCallback = null;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      console.warn('Feishu client not initialized, skipping message send');
      return;
    }

    // 清理确认反应
    const clearAckReaction = () => {
      const ackStored = this.ackReactionByChat.get(chatId);
      if (ackStored) {
        const parts = ackStored.split(':');
        if (parts.length === 2) {
          const [ackMsgId, ackReactionId] = parts;
          this.removeReaction(ackMsgId!, ackReactionId!).catch(() => { });
        }
        this.ackReactionByChat.delete(chatId);
      }
    };

    try {
      // 根据内容长度选择消息类型
      if (text.length <= PLAIN_TEXT_LIMIT) {
        // 短文本，使用纯文本消息
        await this.sendPlainTextMessage(chatId, text);
      } else if (text.length <= CARD_MD_LIMIT) {
        // 中等长度文本，使用交互式卡片
        await this.sendInteractiveCardMessage(chatId, text);
      } else {
        // 长文本，分割成多个卡片消息
        const chunks = this.splitAtParagraphs(text, CARD_MD_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // 如果是第一个消息，可能作为新消息发送，后续消息作为回复
          if (i === 0) {
            await this.sendInteractiveCardMessage(chatId, chunk!);
          } else {
            // 后续消息作为回复发送，但这里我们简单发送新消息，因为飞书回复链可能会很长
            // 为了避免回复链过长，我们选择发送新消息
            await this.sendInteractiveCardMessage(chatId, chunk!);
          }
        }
      }
      console.log(`Message sent to chat ${chatId}`);
      clearAckReaction();
    } catch (error) {
      console.error('Failed to send Feishu message:', error);
      clearAckReaction();
    }
  }

  async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    const lastMsgId = this.lastMessageIdByChat.get(chatId);
    if (!lastMsgId) return;

    if (isTyping) {
      const reactionId = await this.addReaction(lastMsgId, 'OnIt');
      if (reactionId) {
        this.typingReactionByChat.set(chatId, `${lastMsgId}:${reactionId}`);
      }
    } else {
      const stored = this.typingReactionByChat.get(chatId);
      if (stored) {
        const parts = stored.split(':');
        if (parts.length === 2) {
          const [msgId, reactionId] = parts;
          await this.removeReaction(msgId!, reactionId!);
        }
        this.typingReactionByChat.delete(chatId);
      }
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const chatId = message.chat_id;
      const messageId = message.message_id;

      // 消息去重检查
      if (this.isDuplicate(messageId)) {
        console.debug('Duplicate message, skipping');
        return;
      }
      this.markSeen(messageId);

      // 提取消息内容
      const extracted = this.extractMessageContent(message.message_type, message.content);
      let content = extracted.text;

      if (!content && !extracted.imageKeys) {
        console.debug('No text or image content, skipping');
        return;
      }

      // 处理 @ 提及
      if (message.mentions && Array.isArray(message.mentions)) {
        for (const mention of message.mentions) {
          if (mention.key) {
            content = content.replace(mention.key, `@${mention.name || ''}`);
          }
        }
      }

      // 记录最后一条消息ID
      this.lastMessageIdByChat.set(chatId, messageId);

      // 构建消息对象
      const feishuMessage: FeishuMessage = {
        messageId,
        chatId,
        senderId: data.sender.sender_id?.open_id || '',
        senderName: this.getSenderName(data.sender.sender_id?.open_id || ''),
        content,
        messageType: message.message_type,
        timestamp: new Date(parseInt(message.create_time)).toISOString(),
      };

      // 回调处理消息
      if (this.onMessageCallback) {
        this.onMessageCallback(feishuMessage);
      }

      console.log(`Received message from ${feishuMessage.senderName}: ${content}`);
    } catch (error) {
      console.error('Error handling Feishu message:', error);
    }
  }

  private extractMessageContent(messageType: string, content: string): { text: string; imageKeys?: string[] } {
    try {
      const parsed = JSON.parse(content);

      if (messageType === MESSAGE_TYPE_TEXT) {
        return { text: parsed.text || '' };
      }

      if (messageType === MESSAGE_TYPE_POST) {
        // 从富文本中提取文本
        const lines: string[] = [];
        const post = parsed.post;
        if (!post) return { text: '' };

        const contentData = post.zh_cn || post.en_us || Object.values(post)[0];
        if (!contentData || !Array.isArray(contentData.content)) return { text: '' };

        for (const paragraph of contentData.content) {
          if (!Array.isArray(paragraph)) continue;
          for (const segment of paragraph) {
            if (segment.tag === 'text' && segment.text) {
              lines.push(segment.text);
            }
          }
        }

        return { text: lines.join('\n') };
      }

      if (messageType === MESSAGE_TYPE_IMAGE) {
        const imageKey = parsed.image_key;
        if (imageKey) {
          return { text: '[图片]', imageKeys: [imageKey] };
        }
      }

      return { text: '' };
    } catch (error) {
      console.warn('Failed to parse message content:', error);
      return { text: '' };
    }
  }

  /**
   * 发送纯文本消息
   */
  private async sendPlainTextMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) return;

    const lastMsgId = this.lastMessageIdByChat.get(chatId);

    try {
      // 如果文本超过飞书纯文本限制，需要分割
      if (text.length > TEXT_MSG_LIMIT) {
        const chunks = this.splitAtParagraphs(text, TEXT_MSG_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (i === 0 && lastMsgId) {
            // 第一条消息作为回复
            await this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: chunk }),
              },
            });
          } else {
            // 后续消息作为新消息发送
            await this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: chunk }),
              },
            });
          }
        }
      } else {
        // 单条纯文本消息
        if (lastMsgId) {
          // 作为回复发送
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text }),
            },
          });
        } else {
          // 作为新消息发送
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text }),
            },
          });
        }
      }
    } catch (error) {
      console.warn('Plain text message failed, trying fallback:', error);
      await this.sendFallbackMessage(chatId, text);
    }
  }

  /**
   * 发送交互式卡片消息
   */
  private async sendInteractiveCardMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) return;

    const content = this.buildInteractiveCard(text);
    const lastMsgId = this.lastMessageIdByChat.get(chatId);

    try {
      if (lastMsgId) {
        // 作为回复发送
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content,
          },
        });
      } else {
        // 作为新消息发送
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content,
          },
        });
      }
    } catch (error) {
      console.warn('Interactive card message failed, fallback to plain text:', error);
      // 降级为纯文本
      await this.sendPlainTextMessage(chatId, text);
    }
  }

  private buildInteractiveCard(text: string): string {
    const lines = text.split('\n');
    let bodyStartIdx = 0;

    const body = lines.slice(bodyStartIdx).join('\n').trim();
    const contentToRender = body || text.trim();

    return JSON.stringify({
      "schema": "2.0",
      "config": {
        "update_multi": true,
        "style": {
          "text_size": {
            "normal_v2": {
              "default": "normal",
              "pc": "normal",
              "mobile": "heading"
            }
          }
        }
      },
      "body": {
        "direction": "vertical",
        "padding": "12px 12px 12px 12px",
        "elements": [
          {
            "tag": "markdown",
            "content": contentToRender,
            "text_align": "left",
            "text_size": "normal_v2",
            "margin": "0px 0px 0px 0px"
          }
        ]
      }
    });
  }

  private splitAtParagraphs(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      // 优先在段落分隔处分割
      let idx = remaining.lastIndexOf('\n\n', maxLen);
      if (idx < maxLen * 0.3) {
        // 回退到单行分隔
        idx = remaining.lastIndexOf('\n', maxLen);
      }
      if (idx < maxLen * 0.3) {
        // 硬分割
        idx = maxLen;
      }
      chunks.push(remaining.slice(0, idx).trim());
      remaining = remaining.slice(idx).trim();
    }
    if (remaining) chunks.push(remaining);

    return chunks;
  }

  private async sendFallbackMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) return;

    try {
      const lastMsgId = this.lastMessageIdByChat.get(chatId);
      if (lastMsgId) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
      }
    } catch (error) {
      console.error('Fallback message also failed:', error);
    }
  }

  private isDuplicate(msgId: string): boolean {
    const now = Date.now();
    // 清理过期缓存（30分钟）
    for (const [id, ts] of this.messageCache.entries()) {
      if (now - ts > 30 * 60 * 1000) {
        this.messageCache.delete(id);
      }
    }
    // 限制缓存大小
    if (this.messageCache.size >= 1000) {
      const firstKey = this.messageCache.keys().next().value;
      if (firstKey) this.messageCache.delete(firstKey);
    }
    return this.messageCache.has(msgId);
  }

  private markSeen(msgId: string): void {
    this.messageCache.delete(msgId);
    this.messageCache.set(msgId, Date.now());
  }

  private getSenderName(openId: string): string {
    // 简化实现，实际应该缓存用户信息
    return openId;
  }

  /**
   * 添加反应（用于消息确认和输入状态）
   */
  private async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    if (!this.client) return null;

    try {
      const res = (await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      })) as { data?: { reaction_id?: string } };
      return res.data?.reaction_id || null;
    } catch (error) {
      console.debug('Failed to add reaction:', error);
      return null;
    }
  }

  /**
   * 移除反应
   */
  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (error) {
      console.debug('Failed to remove reaction:', error);
    }
  }
}