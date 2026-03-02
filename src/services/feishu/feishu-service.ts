import * as lark from '@larksuiteoapi/node-sdk';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import mime from 'mime';
import { extname, isAbsolute, resolve, join } from 'path';
import type {
  FeishuConnection,
  FeishuConnectionConfig,
  FeishuMessage,
  ImageUploadOptions,
  ImageUploadResult,
  ContentProcessResult
} from './types.js';
import { fileURLToPath } from 'url';

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

function getExtFromContentType(contentType: string) {
  const type = contentType.split(';')?.[0]?.trim() || '';
  const ext = mime.getExtension(type);
  return ext ? `.${ext}` : '';
}

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
        // appType: lark.AppType.SelfBuild,
        loggerLevel: lark.LoggerLevel.debug,
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

  // shouldMarkdown 强制使用 markdown 格式
  async sendMessage(chatId: string, text: string, messageId?: string, threadId?: string): Promise<void> {
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
      // 处理内容中的图片
      const processResult = await this.processContentWithImages(text);

      if (processResult.errors.length > 0) {
        console.warn('Some images failed to upload:', processResult.errors);
      }

      const processedText = processResult.processedText;

      // 根据内容长度选择消息类型
      if (processedText.length <= PLAIN_TEXT_LIMIT && !processResult.imageKeys.length) {
        // 短文本，使用纯文本消息
        await this.sendPlainTextMessage(chatId, processedText, messageId, threadId);
      } else if (processedText.length <= CARD_MD_LIMIT) {
        // 中等长度文本，使用交互式卡片
        await this.sendInteractiveCardMessage(chatId, processedText, messageId, threadId);
      } else {
        // 长文本，分割成多个卡片消息
        const chunks = this.splitAtParagraphs(processedText, CARD_MD_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // 如果是第一个消息，可能作为新消息发送，后续消息作为回复
          if (i === 0) {
            await this.sendInteractiveCardMessage(chatId, chunk!, messageId, threadId);
          } else {
            // 后续消息作为回复发送，但这里我们简单发送新消息，因为飞书回复链可能会很长
            // 为了避免回复链过长，我们选择发送新消息
            await this.sendInteractiveCardMessage(chatId, chunk!, undefined, threadId);
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

  async sendTyping(chatId: string, isTyping: boolean, threadId?: string): Promise<void> {
    if (!this.client) return;
    const lastMsgId = this.lastMessageIdByChat.get(chatId);
    if (!lastMsgId) return;
    // Note: threadId is kept for forward compatibility but ignored in implementation
    // Feishu has no native typing API; we use messageReaction which is bound to message_id, not thread

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
      const threadId = message.thread_id;
      // 消息去重检查
      if (this.isDuplicate(messageId)) {
        console.debug('Duplicate message, skipping');
        return;
      }
      this.markSeen(messageId);

      // 提取消息内容
      const extracted = this.extractMessageContent(message.message_type, message.content, message.create_time);
      let content = extracted.text;

      if (!content && !extracted.imageKeys && !extracted.fileKeys) {
        console.debug('No text or image content or file content, skipping');
        return;
      }

      // 下载图片（如果有）
      if (extracted.imageKeys && extracted.imageKeys.length > 0) {
        for (let i = 0; i < extracted.imageKeys.length; i++) {
          const imageKey = extracted.imageKeys[i] as string;
          try {
            const filePath = await this.downloadFile(
              messageId,
              imageKey,
              `${message.create_time}-image-${i}`,
              'image'
            );
            console.log(`图片下载成功: ${filePath}`);
          } catch (downloadError) {
            console.error(`下载图片失败: ${imageKey}`, downloadError);
          }
        }
      }

      // 处理 @ 提及
      if (message.mentions && Array.isArray(message.mentions)) {
        for (const mention of message.mentions) {
          if (mention.key) {
            content = content.replace(mention.key, `@${mention.name || ''}`);
          }
        }
      }

      // // 下载文件（如果有）
      // if (extracted.fileKeys?.length) {
      //   console.log(`检测到 ${extracted.fileKeys.length} 个文件，开始下载...`);
      //   for (let i = 0; i < extracted.fileKeys.length; i++) {
      //     const fileKey = extracted.fileKeys[i] as string;
      //     try {
      //       const filePath = await this.downloadFile(
      //         messageId,
      //         fileKey,
      //         `${message.create_time}-file-${i}`,
      //         'file'
      //       );
      //       console.log(`文件下载成功: ${filePath}`);
      //     } catch (downloadError) {
      //       console.error(`下载文件失败: ${fileKey}`, downloadError);
      //     }
      //   }
      // }

      // 记录最后一条消息ID
      this.lastMessageIdByChat.set(chatId, messageId);

      // 构建消息对象
      const feishuMessage: FeishuMessage = {
        messageId,             // IMPORTANT: needed for im.message.reply
        chatId,
        threadId,              // NEW: pass through thread ID (undefined for non-thread groups)
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

private extractMessageContent(messageType: string, content: string, createTime: string): { text: string; imageKeys?: string[]; fileKeys?: string[] } {
  try {
    const parsed = JSON.parse(content);

    if (messageType === MESSAGE_TYPE_TEXT) {
      return { text: parsed.text || '' };
    }

    if (messageType === MESSAGE_TYPE_POST) {
      const lines: string[] = [];
      const imageKeys: string[] = [];
      const fileKeys: string[] = [];

      const contentArray = parsed.content;
      if (!Array.isArray(contentArray)) return { text: parsed.title || '' };

      let imageIdx = 0;
      let mediaIdx = 0;

      for (const paragraph of contentArray) {
        if (!Array.isArray(paragraph)) continue;

        const paragraphTexts: string[] = [];

        for (const segment of paragraph) {
          if (!segment || !segment.tag) continue;

          switch (segment.tag) {
            case 'text':
              if (segment.text) paragraphTexts.push(segment.text);
              break;
            case 'a':
              paragraphTexts.push(segment.text || segment.href || '');
              break;
            case 'at':
              if (segment.user_id) {
                paragraphTexts.push(`@${segment.user_name || segment.user_id}`);
              }
              break;
            case 'img':
              if (segment.image_key) {
                imageKeys.push(segment.image_key);
                paragraphTexts.push(`![${createTime}-image-${imageIdx++}](data/lark/images/${createTime}-image-${imageIdx++})`);
              }
              break;
            case 'media':
              if (segment.file_key) {
                fileKeys.push(segment.file_key);
                paragraphTexts.push(`data/lark/files/${createTime}-file-${mediaIdx++}`);
              }
              break;
            case 'emotion':
              if (segment.emoji_type) paragraphTexts.push(`[表情:${segment.emoji_type}]`);
              break;
            case 'code_block':
              if (segment.text) paragraphTexts.push(`\`\`\`${segment.language || ''}\n${segment.text}\n\`\`\``);
              break;
            case 'md':
              if (segment.text) paragraphTexts.push(segment.text);
              break;
            case 'hr':
              paragraphTexts.push('---');
              break;
            default:
              if (segment.text) paragraphTexts.push(segment.text);
              break;
          }
        }

        if (paragraphTexts.length > 0) lines.push(paragraphTexts.join(''));
      }

      const title = parsed.title ? `${parsed.title}\n` : '';

      return {
        text: title + lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
        fileKeys: fileKeys.length > 0 ? fileKeys : undefined,
      };
    }

    if (messageType === MESSAGE_TYPE_IMAGE) {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return {
          text: `${createTime}-image-0`,
          imageKeys: [imageKey],
          fileKeys: parsed.file_key ? [parsed.file_key] : undefined,
        };
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
  private async sendPlainTextMessage(chatId: string, text: string, replyMessageId?: string, threadId?: string): Promise<void> {
    if (!this.client) return;

    try {
      // 如果文本超过飞书纯文本限制，需要分割
      if (text.length > TEXT_MSG_LIMIT) {
        const chunks = this.splitAtParagraphs(text, TEXT_MSG_LIMIT);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // 第一条消息作为回复（如果有replyMessageId），否则作为新消息
          if (i === 0 && replyMessageId) {
            await this.client.im.message.reply({
              path: { message_id: replyMessageId },
              data: {
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
                ...(threadId ? { thread_id: threadId } : {}),
              },
            });
          }
        }
      } else {
        // 单条纯文本消息
        if (replyMessageId) {
          // 作为回复发送（使用im.message.reply自动关联到thread）
          await this.client.im.message.reply({
            path: { message_id: replyMessageId },
            data: {
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
              ...(threadId ? { thread_id: threadId } : {}),
            },
          });
        }
      }
    } catch (error) {
      console.warn('Plain text message failed, trying fallback:', error);
      await this.sendFallbackMessage(chatId, text, replyMessageId, threadId);
    }
  }

  /**
   * 发送交互式卡片消息
   */
  private async sendInteractiveCardMessage(chatId: string, text: string, replyMessageId?: string, threadId?: string): Promise<void> {
    if (!this.client) return;

    const content = this.buildInteractiveCard(text);

    try {
      if (replyMessageId) {
        // 作为回复发送（使用im.message.reply自动关联到thread）
        await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
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
            ...(threadId ? { thread_id: threadId } : {}),
          },
        });
      }
    } catch (error) {
      console.warn('Interactive card message failed, fallback to plain text:', error);
      // 降级为纯文本
      await this.sendPlainTextMessage(chatId, text, replyMessageId, threadId);
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

  private async sendFallbackMessage(chatId: string, text: string, replyMessageId?: string, threadId?: string): Promise<void> {
    if (!this.client) return;

    try {
      if (replyMessageId) {
        // 作为回复发送（使用im.message.reply自动关联到thread）
        await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
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
            ...(threadId ? { thread_id: threadId } : {}),
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

  /**
   * 上传图片到飞书
   */
  async uploadImage(filePath: string, options?: ImageUploadOptions): Promise<ImageUploadResult> {
    if (!this.client) {
      return { success: false, error: 'Feishu client not initialized' };
    }

    const maxFileSize = options?.maxFileSize || 10 * 1024 * 1024; // 默认10MB

    try {
      // 验证文件存在性
      if (!existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      // 验证文件大小
      const stats = statSync(filePath);
      if (stats.size > maxFileSize) {
        return { success: false, error: `File too large: ${stats.size} bytes (max: ${maxFileSize} bytes)` };
      }

      // 验证文件类型（通过后缀名）
      const ext = extname(filePath).toLowerCase();
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
      if (!allowedExtensions.includes(ext)) {
        return { success: false, error: `Unsupported file type: ${ext}` };
      }

      // 读取文件内容
      const fileBuffer = readFileSync(filePath);

      // 上传图片
      const result = await this.client.im.image.create({
        data: {
          image: fileBuffer,
          image_type: 'message',
        },
      });
      console.log(JSON.stringify(result, null, 2))

      const imageKey = result?.image_key;
      if (imageKey) {
        console.log(`Image uploaded successfully: ${filePath} -> ${imageKey}`);
        return { success: true, imageKey };
      } else {
        return { success: false, error: 'Failed to get image key from response' };
      }
    } catch (error) {
      console.error(`Failed to upload image ${filePath}:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * 从 HTTPS URL 下载图片并上传到飞书
   */
  async uploadImageFromUrl(
    imageUrl: string,
    options?: ImageUploadOptions
  ): Promise<ImageUploadResult> {
    if (!this.client) {
      return { success: false, error: 'Feishu client not initialized' };
    }

    if (!imageUrl.startsWith('https://')) {
      return { success: false, error: 'Only HTTPS URLs are supported' };
    }

    const maxFileSize = options?.maxFileSize || 10 * 1024 * 1024;
    const timeout = options?.timeout || 30000;
    const allowedContentTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/bmp',
      'image/webp',
      'image/svg+xml',
    ];

    try {
      // 超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      let response: Response;
      try {
        response = await fetch(imageUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'FeishuImageUploader/1.0' },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        return { success: false, error: `HTTP request failed with status: ${response.status}` };
      }

      // 验证 Content-Type
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType && !allowedContentTypes.includes(contentType)) {
        return { success: false, error: `Unsupported content type: ${contentType}` };
      }

      // 预检 Content-Length
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxFileSize) {
        return {
          success: false,
          error: `File too large: ${contentLength} bytes (max: ${maxFileSize} bytes)`,
        };
      }

      // 读取为 Buffer
      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      if (fileBuffer.length > maxFileSize) {
        return {
          success: false,
          error: `File too large: ${fileBuffer.length} bytes (max: ${maxFileSize} bytes)`,
        };
      }

      if (fileBuffer.length === 0) {
        return { success: false, error: 'Downloaded file is empty' };
      }

      // 上传到飞书 —— 匹配 @larksuiteoapi/node-sdk 的 im.v1.image.create 签名
      const res = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fileBuffer,
        },
      });

      const imageKey = res?.image_key;
      if (imageKey) {
        console.log(`Image uploaded from URL successfully: ${imageUrl} -> ${imageKey}`);
        return { success: true, imageKey };
      } else {
        return { success: false, error: 'Failed to get image key from response' };
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { success: false, error: `Download timed out after ${timeout}ms` };
      }
      console.error(`Failed to upload image from URL ${imageUrl}:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * 处理文本内容，自动检测并上传图片（支持本地路径和远程URL）
   */
  async processContentWithImages(text: string): Promise<ContentProcessResult> {
    const imageKeys: string[] = [];
    const errors: string[] = [];

    const IMG_EXT = 'jpg|jpeg|png|gif|bmp|webp|svg';

    // ===== 第1步：提取所有图片路径 =====
    const pathPattern = new RegExp(
      `(?:https?|file):\\/\\/[^\\s\\)"'<>]+\\.(?:${IMG_EXT})(?:\\?[^\\s\\)"'<>]*)?` +
      `|[a-zA-Z]:\\\\[^\\s\\)"'<>]+\\.(?:${IMG_EXT})` +
      `|\\.{0,2}[\\\\\/][^\\s\\)"'<>]+\\.(?:${IMG_EXT})`,
      'gi'
    );

    const allPaths = [...new Set(text.match(pathPattern) || [])];
    if (allPaths.length === 0) {
      return { processedText: text, imageKeys: [], errors: [] };
    }

    // ===== 第2步：批量上传，构建替换映射 =====
    const replacements = new Map<string, string>();

    await Promise.all(allPaths.map(async (imgPath) => {
      try {
        const result = await this.resolveAndUpload(imgPath);
        if (result.success && result.imageKey) {
          replacements.set(imgPath, result.imageKey);
          imageKeys.push(result.imageKey);
        } else {
          errors.push(`Upload failed: ${imgPath} - ${result.error}`);
        }
      } catch (e) {
        errors.push(`Error: ${imgPath} - ${e instanceof Error ? e.message : 'Unknown'}`);
      }
    }));

    if (replacements.size === 0) {
      return { processedText: text, imageKeys: [], errors };
    }

    // ===== 第3步：一次性替换 =====
    // 构建一个大正则，按路径长度降序排列（避免短路径先匹配吃掉长路径的一部分）
    const sorted = [...replacements.keys()]
      .sort((a, b) => b.length - a.length);

    const escaped = sorted
      .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    // 统一匹配：![alt](path) 或 <img src="path"> 或 裸路径
    const masterPattern = new RegExp(
      `(!\\[[^\\]]*\\]\\()` +              // Markdown 前缀: ![alt](
      `(${escaped.join('|')})` +           // 图片路径（核心捕获）
      `(\\))` +                            // Markdown 后缀: )
      `|(<img\\s[^>]*?src=["'])` +         // HTML img 前缀
      `(${escaped.join('|')})` +           // 图片路径
      `(["'][^>]*?>)` +                    // HTML img 后缀
      `|(${escaped.join('|')})`,           // 裸路径
      'gi'
    );

    const processedText = text.replace(masterPattern, (...args) => {
      // Markdown: ![alt](path)
      if (args[1] && args[2]) {
        const key = replacements.get(args[2]);
        return key ? `${args[1]}${key}${args[3]}` : args[0];
      }
      // HTML: <img src="path">
      if (args[4] && args[5]) {
        const key = replacements.get(args[5]);
        return key ? `${args[4]}${key}${args[6]}` : args[0];
      }
      // 裸路径
      if (args[7]) {
        const key = replacements.get(args[7]);
        return key ? `![](${key})` : args[0];
      }
      return args[0];
    });

    return { processedText, imageKeys, errors };
  }

  // 统一的路径解析 + 上传
  private async resolveAndUpload(imagePath: string): Promise<ImageUploadResult> {
    if (imagePath.startsWith('file://')) {
      // file:// 转本地路径
      const localPath = fileURLToPath(imagePath); // Node.js url 模块
      return this.uploadImage(localPath);
    } else if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return this.uploadImageFromUrl(imagePath);
    } else {
      const resolved = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath);
      return this.uploadImage(resolved);
    }
  }

  /**
   * 发送处理后的消息（包含图片自动上传）
   */
  async sendMessageWithProcessedContent(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      console.warn('Feishu client not initialized, skipping message send');
      return;
    }

    try {
      // 处理内容中的图片
      const processResult = await this.processContentWithImages(text);

      if (processResult.errors.length > 0) {
        console.warn('Some images failed to upload:', processResult.errors);
      }

      // 使用处理后的文本发送消息
      await this.sendMessage(chatId, processResult.processedText);

      console.log(`Message with processed content sent to chat ${chatId}`);
    } catch (error) {
      console.error('Failed to send message with processed content:', error);
      // 降级为原始文本发送
      await this.sendMessage(chatId, text);
    }
  }

  /**
   * 下载飞书图片/文件
   * @param messageId 消息ID
   * @param fileKey 文件key（用于messageResource.get API）
   * @param timestamp 时间戳（用于文件名），可选，默认使用当前时间
   * @returns 下载后的本地文件路径
   */
  async downloadFile(
    messageId: string,
    fileKey: string,
    timestamp: string,
    type: 'image' | 'file',
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    try {
      // 确保目录存在
      const imageDir = join(process.cwd(), 'data', 'lark', `${type}s`);
      if (!existsSync(imageDir)) {
        mkdirSync(imageDir, { recursive: true });
      }

      if (!fileKey) {
        throw new Error('fileKey is required for downloading image');
      }

      const response = await this.client.im.v1.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type,
        },
      });

      // 生成文件名
      const fileName = `${timestamp || Date.now()}${getExtFromContentType(response.headers['Content-Type'] || response.headers['content-type'] || '')}`;
      const filePath = join(imageDir, fileName);

      // 获取图片数据 - SDK 返回的是二进制数据
      await response.writeFile(filePath);

      return filePath;
    } catch (error) {
      console.error('下载飞书图片失败:', error);
      throw error;
    }
  }
}