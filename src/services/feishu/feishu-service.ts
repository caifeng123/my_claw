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
  FileUploadResult,
  ContentProcessResult,
  MessageDetail,
} from './types.js';
import { fileURLToPath } from 'url';
import { IdentityResolver } from './identity-resolver.js';
import { parseMentions, isBotMentioned as checkBotMentioned } from './mention-utils.js';

// AI 修复重试配置
const AI_FIX_MAX_RETRIES = 2; // AI 修复最大重试次数

/**
 * 飞书消息发送错误（包含飞书 API 返回的详细信息）
 */
export class FeishuSendError extends Error {
  /** 飞书业务错误码，如 230028 表示内容审核不通过 */
  code: number;
  /** 飞书返回的错误描述 */
  feishuMsg: string;
  /** 原始发送的文本内容 */
  originalContent: string;

  constructor(code: number, feishuMsg: string, originalContent: string) {
    super(`Feishu send failed [${code}]: ${feishuMsg}`);
    this.name = 'FeishuSendError';
    this.code = code;
    this.feishuMsg = feishuMsg;
    this.originalContent = originalContent;
  }
}

/**
 * 从 Axios 错误中提取飞书 API 的业务错误信息
 */
function extractFeishuError(error: any): { code: number; msg: string } | null {
  try {
    // 飞书 SDK 抛出的 Axios 错误，response.data 中包含业务错误
    const data = error?.response?.data;
    if (data && typeof data.code === 'number' && typeof data.msg === 'string') {
      return { code: data.code, msg: data.msg };
    }
    // 有些 SDK 版本会将错误信息放在 error.data
    if (error?.data && typeof error.data.code === 'number') {
      return { code: error.data.code, msg: error.data.msg || '' };
    }
  } catch {
    // 解析失败，返回 null
  }
  return null;
}

// 飞书消息类型
const MESSAGE_TYPE_TEXT = 'text';
const MESSAGE_TYPE_POST = 'post';
const MESSAGE_TYPE_IMAGE = 'image';
const MESSAGE_TYPE_FILE = 'file';

// 消息类型选择阈值
const PLAIN_TEXT_LIMIT = 200; // 少于200字符使用纯文本
const CARD_MD_LIMIT = 4000; // 卡片消息限制
const TEXT_MSG_LIMIT = 2048; // 飞书纯文本消息限制

// 消息去重缓存设置
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30分钟

// 文件上传大小限制 (30MB)
const FILE_UPLOAD_MAX_SIZE = 30 * 1024 * 1024;

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

  // ==================== NEW: 机器人身份（用于群聊 @Bot 过滤 + prompt 注入） ====================
  private botOpenId: string | null = null;
  private botName: string | null = null;

  // ==================== NEW: 用户身份解析器（openId → 姓名/邮箱 永久缓存） ====================
  private identityResolver: IdentityResolver | null = null;



  // [FIX] 生成考虑 threadId 的存储 key，避免话题群多 thread 共享 chatId 导致 reaction 互相覆盖
  private getReactionKey(chatId: string, threadId?: string): string {
    return threadId ? `${chatId}:${threadId}` : chatId;
  }


  constructor(config: FeishuConnectionConfig) {
    this.config = config;
  }


  // ==================== NEW: 暴露 Client 实例 ====================

  /**
   * 获取飞书 SDK Client 实例
   */
  getClient(): lark.Client | null {
    return this.client;
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
        loggerLevel: lark.LoggerLevel.info,
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

      // 获取机器人自身的 open_id，用于群聊 @Bot 过滤
      this.fetchBotOpenId().catch(err => {
        console.warn('⚠️ 获取机器人 open_id 失败，群聊将响应所有消息:', err);
      });

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

    // [FIX] 使用 threadId-aware key 清理确认反应
    const ackKey = this.getReactionKey(chatId, threadId);
    const clearAckReaction = () => {
      const ackStored = this.ackReactionByChat.get(ackKey);
      if (ackStored) {
        const sepIdx = ackStored.indexOf('|');
        if (sepIdx > 0) {
          const ackMsgId = ackStored.slice(0, sepIdx);
          const ackReactionId = ackStored.slice(sepIdx + 1);
          this.removeReaction(ackMsgId, ackReactionId).catch(() => { });
        }
        this.ackReactionByChat.delete(ackKey);
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
          if (i === 0) {
            await this.sendInteractiveCardMessage(chatId, chunk!, messageId, threadId);
          } else {
            await this.sendInteractiveCardMessage(chatId, chunk!, messageId, threadId);
          }
        }
      }
      console.log(`Message sent to chat ${chatId}`);
      clearAckReaction();
    } catch (error) {
      console.error('Failed to send Feishu message:', error);
      clearAckReaction();
      // 向上抛出 FeishuSendError，让 bridge 层有机会进行 AI 修复
      if (error instanceof FeishuSendError) {
        throw error;
      }
    }
  }

  async sendTyping(chatId: string, isTyping: boolean, threadId?: string): Promise<void> {
    if (!this.client) return;
    // [FIX] 使用 threadId-aware key，避免话题群多 thread 共享 chatId 时 reaction 互相覆盖
    const reactionKey = this.getReactionKey(chatId, threadId);
    const lastMsgId = this.lastMessageIdByChat.get(reactionKey);
    if (!lastMsgId) return;

    if (isTyping) {
      const reactionId = await this.addReaction(lastMsgId, 'OnIt');
      if (reactionId) {
        // [FIX] 使用 "|" 分隔符替代 ":"，避免与飞书 message_id 中可能存在的冒号冲突
        this.typingReactionByChat.set(reactionKey, `${lastMsgId}|${reactionId}`);
      }
    } else {
      const stored = this.typingReactionByChat.get(reactionKey);
      if (stored) {
        const sepIdx = stored.indexOf('|');
        if (sepIdx > 0) {
          const msgId = stored.slice(0, sepIdx);
          const reactionId = stored.slice(sepIdx + 1);
          await this.removeReaction(msgId, reactionId);
        }
        this.typingReactionByChat.delete(reactionKey);
      }
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  /**
   * 获取机器人自身的 open_id（用于群聊 @Bot 判断）
   * 调用 bot.v3.botInfo.get API
   */
  private async fetchBotOpenId(): Promise<void> {
    if (!this.client) return;
    try {
      // 使用 client.request() 直接调 REST API（兼容所有 SDK 版本）
      const res = await (this.client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      console.log('🔍 [fetchBotOpenId] API 响应:', JSON.stringify(res?.data || res, null, 2));

      const bot = res?.data?.bot ?? res?.bot;
      const openId = bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        this.botName = bot?.app_name || 'Bot';
        console.log(`🤖 机器人信息已获取: ${this.botName} (${openId})`);
      } else {
        console.warn('⚠️ /open-apis/bot/v3/info 未返回 open_id，完整响应:', JSON.stringify(res, null, 2));
      }
    } catch (error) {
      console.warn('⚠️ 获取机器人 open_id 失败:', error);
    }

    // 无论 bot info 是否成功，都初始化 IdentityResolver
    this.identityResolver = new IdentityResolver(
      './data/identity-cache.json',
      () => this.client,
    );
    console.log(`📇 IdentityResolver 已初始化，缓存 ${this.identityResolver.cacheSize} 个用户`);
  }

  // ==================== NEW: 暴露 bot 身份 & IdentityResolver ====================

  /** 获取机器人的 open_id */
  getBotOpenId(): string | null {
    return this.botOpenId;
  }

  /** 获取机器人的名称 */
  getBotName(): string | null {
    return this.botName;
  }

  /** 获取 IdentityResolver 实例 */
  getIdentityResolver(): IdentityResolver | null {
    return this.identityResolver;
  }

  /**
   * 检查群聊消息是否 @了机器人（委托给纯函数 mention-utils.isBotMentioned）
   */
  private isBotMentioned(mentions: any[]): boolean {
    return checkBotMentioned(mentions, this.botOpenId || undefined);
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const threadId = message.thread_id;

      // ==================== NEW: 提取引用/回复消息 ID ====================
      // parent_id: 话题群中直接回复的父消息 ID
      // upper_message_id: 普通群引用(quote)消息的原消息 ID
      const parentId = message.parent_id || message.upper_message_id || undefined;

      // 消息去重检查
      if (this.isDuplicate(messageId)) {
        console.debug('Duplicate message, skipping');
        return;
      }
      this.markSeen(messageId);

      // ==================== NEW: 群聊 @Bot 过滤 ====================
      // chat_type: "p2p" (私聊) / "group" (群聊)
      const chatType = message.chat_type;
      if (chatType === 'group') {
        const mentions = message.mentions;
        if (!this.isBotMentioned(mentions)) {
          console.debug(`群聊消息未 @机器人，跳过处理 [chatId=${chatId}, msgId=${messageId}]`);
          return;
        }
      }

      // 提取消息内容（使用占位符，不再硬编码路径）
      const extracted = this.extractMessageContent(message.message_type, message.content);
      let content = extracted.text;

      if (!content && !extracted.imageKeys && !extracted.fileKeys) {
        console.debug('No text or image content or file content, skipping');
        return;
      }

      // [FIX] 图片下载已统一由 bridge 层管理（下载到 session 目录），
      // [FIX] 图片下载已统一由 bridge 层管理（下载到 session 目录），service 层不再冗余下载。
      // 如需单独使用 service 层（不经过 bridge），可取消此处注释。

      // ==================== 处理 @ 提及（结构化 + 文本替换） ====================
      console.log('🔍 [handleMessage] 原始 mentions:', JSON.stringify(message.mentions, null, 2));
      console.log('🔍 [handleMessage] 替换前 content:', content);

      const { content: replacedContent, mentions: structuredMentions, identityHints } =
        parseMentions(content, message.mentions, this.botOpenId || undefined);
      content = replacedContent;

      // 将 mention 中的身份信息写入缓存
      if (this.identityResolver) {
        for (const [openId, name] of identityHints) {
          this.identityResolver.cacheFromMention(openId, name);
        }
      }

      console.log('🔍 [handleMessage] 替换后 content:', content);
      console.log('🔍 [handleMessage] 结构化 mentions:', JSON.stringify(structuredMentions, null, 2));

      // 记录最后一条消息ID
      this.lastMessageIdByChat.set(this.getReactionKey(chatId, threadId), messageId);

      // 构建消息对象
      const feishuMessage: FeishuMessage = {
        messageId,
        chatId,
        threadId,
        senderId: data.sender.sender_id?.open_id || '',
        senderName: this.getSenderName(data.sender.sender_id?.open_id || ''),
        content,
        messageType: message.message_type,
        timestamp: new Date(parseInt(message.create_time)).toISOString(),

        // ==================== NEW: 附加字段 ====================
        parentId,
        mentions: structuredMentions.length > 0 ? structuredMentions : undefined,
        imageKeys: extracted.imageKeys,
        fileKeys: extracted.fileKeys,
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

  /**
   * 提取消息内容
   * 修改：使用占位符代替硬编码路径，实际路径由 bridge 层在下载后替换
   */
  extractMessageContent(messageType: string, content: string): { text: string; imageKeys?: string[]; fileKeys?: string[] } {
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
                  // 使用占位符，bridge 层下载后替换为实际路径
                  paragraphTexts.push(`![image]({{FILE:${segment.image_key}}})`);
                }
                break;
              case 'media':
                if (segment.file_key) {
                  fileKeys.push(segment.file_key);
                  paragraphTexts.push(`{{FILE:${segment.file_key}}}`);
                }
                break;
              case 'emotion':
                if (segment.emoji_type) paragraphTexts.push(`[表情:${segment.emoji_type}]`);
                break;
              case 'code_block':
                if (segment.text) paragraphTexts.push('```' + (segment.language || '') + '\n' + segment.text + '\n```');
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
            text: `{{FILE:${imageKey}}}`,
            imageKeys: [imageKey],
            fileKeys: parsed.file_key ? [parsed.file_key] : undefined,
          };
        }
      }

      // ==================== NEW: 文件消息类型 ====================
      if (messageType === MESSAGE_TYPE_FILE) {
        const fileKey = parsed.file_key;
        const fileName = parsed.file_name || 'unknown_file';
        if (fileKey) {
          return {
            text: `[文件: ${fileName}] {{FILE:${fileKey}}}`,
            fileKeys: [fileKey],
          };
        }
      }

      // ==================== interactive 卡片消息 ====================
      if (messageType === 'interactive') {
        return { text: '暂不支持读取卡片详细内容' };
      }

      return { text: '' };
    } catch (error) {
      console.warn('Failed to parse message content:', error);
      return { text: '' };
    }
  }

  // ==================== NEW: 获取消息详情（用于读取引用消息） ====================

  /**
   * 通过 message_id 获取消息详情
   * 调用飞书 im.v1.message.get API
   * 频率限制: 1000 次/分钟, 50 次/秒
   *
   * @param messageId 消息 ID
   * @returns 消息详情，失败返回 null
   */
  async getMessageDetail(messageId: string): Promise<MessageDetail | null> {
    if (!this.client) {
      console.warn('Feishu client not initialized');
      return null;
    }

    try {
      const response = await this.client.im.message.get({
        path: { message_id: messageId },
      });


      const items = (response as any)?.data?.items;
      if (!items || items.length === 0) {
        // 尝试直接从 response 中查找（某些 SDK 版本可能结构不同）
        const directItems = (response as any)?.items;
        if (directItems && directItems.length > 0) {
          const msg = directItems[0];
          return {
            messageId: msg.message_id,
            parentId: msg.parent_id || undefined,
            rootId: msg.root_id || undefined,
            msgType: msg.msg_type,
            body: {
              content: msg.body?.content || '{}',
            },
            sender: msg.sender ? {
              senderType: msg.sender.sender_type,
              senderId: msg.sender.sender_id ? {
                openId: msg.sender.sender_id.open_id,
                userId: msg.sender.sender_id.user_id,
              } : undefined,
            } : undefined,
            createTime: msg.create_time,
            updateTime: msg.update_time,
          };
        }
        return null;
      }

      const msg = items[0];
      return {
        messageId: msg.message_id,
        parentId: msg.parent_id || undefined,
        rootId: msg.root_id || undefined,
        msgType: msg.msg_type,
        body: {
          content: msg.body?.content || '{}',
        },
        sender: msg.sender ? {
          senderType: msg.sender.sender_type,
          senderId: msg.sender.sender_id ? {
            openId: msg.sender.sender_id.open_id,
            userId: msg.sender.sender_id.user_id,
          } : undefined,
        } : undefined,
        createTime: msg.create_time,
        updateTime: msg.update_time,
      };
    } catch (error: any) {
      console.error(`getMessageDetail failed for ${messageId}:`, error?.message || error);
      return null;
    }
  }

  /**
   * 获取引用消息的文本内容
   * 自动解析消息类型并提取纯文本
   *
   * @param messageId 被引用消息的 message_id
   * @returns 文本内容，失败返回 null
   */
  async getQuotedMessageContent(messageId: string): Promise<{
    text: string | null;
    imageKeys?: string[];
    fileKeys?: string[];
    messageId?: string;
  }> {
    const detail = await this.getMessageDetail(messageId);
    if (!detail) return { text: null };

    try {
      // 卡片消息：飞书 API 不返回原始卡片内容
      if (detail.msgType === 'interactive') {
        return { text: '暂不支持读取卡片详细内容' };
      }

      const extracted = this.extractMessageContent(detail.msgType, detail.body.content);
      return {
        text: extracted.text || null,
        imageKeys: extracted.imageKeys,
        fileKeys: extracted.fileKeys,
        messageId: detail.messageId,
      };
    } catch (error) {
      console.error(`Failed to extract quoted message content for ${messageId}:`, error);
      return { text: null };
    }
  }

  // ==================== NEW: 文件上传 & 发送 ====================

  /**
   * 上传文件到飞书（im.v1.file.create）
   *
   * @param filePath 本地文件路径
   * @param fileType 文件类型: opus/mp4/pdf/doc/xls/ppt/stream
   * @param fileName 显示的文件名（可选，默认从路径提取）
   * @returns 上传结果，包含 file_key
   */
  async uploadFile(
    filePath: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream',
    fileName?: string,
  ): Promise<FileUploadResult> {
    if (!this.client) {
      return { success: false, error: 'Feishu client not initialized' };
    }

    try {
      // 验证文件存在
      if (!existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      // 验证文件大小（30MB 限制）
      const stats = statSync(filePath);
      if (stats.size > FILE_UPLOAD_MAX_SIZE) {
        return { success: false, error: `File too large: ${stats.size} bytes (max: ${FILE_UPLOAD_MAX_SIZE} bytes)` };
      }

      const actualFileName = fileName || filePath.split('/').pop() || 'file';
      const fileBuffer = readFileSync(filePath);

      const response = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: actualFileName,
          file: fileBuffer,
        },
      });

      const fileKey = (response as any)?.file_key;
      if (fileKey) {
        console.log(`File uploaded successfully: ${filePath} -> ${fileKey}`);
        return { success: true, fileKey };
      } else {
        return { success: false, error: 'Failed to get file_key from response' };
      }
    } catch (error) {
      console.error(`Failed to upload file ${filePath}:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * 发送文件消息到飞书聊天
   *
   * @param chatId 聊天 ID
   * @param fileKey 已上传文件的 file_key
   * @param replyMessageId 回复消息 ID（可选）
   * @param threadId 话题 ID（可选）
   */
  async sendFileMessage(
    chatId: string,
    fileKey: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.client) {
      console.warn('Feishu client not initialized, skipping file send');
      return;
    }

    const content = JSON.stringify({ file_key: fileKey });
    try {
      if (replyMessageId) {
        await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
            msg_type: 'file',
            content,
          },
        });
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content,
            ...(threadId ? { thread_id: threadId } : {}),
          },
        });
      }

      console.log(`File message sent to chat ${chatId}, fileKey=${fileKey}`);
    } catch (error) {
      console.error(`Failed to send file message to ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * 一站式：上传本地文件并发送到聊天
   *
   * @param chatId 聊天 ID
   * @param filePath 本地文件路径
   * @param replyMessageId 回复消息 ID（可选）
   * @param threadId 话题 ID（可选）
   * @param fileType 文件类型（可选，默认 stream）
   */
  async uploadAndSendFile(
    chatId: string,
    filePath: string,
    replyMessageId?: string,
    threadId?: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream',
  ): Promise<void> {
    const uploadResult = await this.uploadFile(filePath, fileType);

    if (!uploadResult.success || !uploadResult.fileKey) {
      throw new Error(`File upload failed: ${uploadResult.error}`);
    }

    await this.sendFileMessage(chatId, uploadResult.fileKey, replyMessageId, threadId);
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
          if (replyMessageId) {
            await this.client.im.message.reply({
              path: { message_id: replyMessageId },
              data: {
                msg_type: 'text',
                content: JSON.stringify({ text: chunk }),
              },
            });
          } else {
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
        if (replyMessageId) {
          await this.client.im.message.reply({
            path: { message_id: replyMessageId },
            data: {
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
              ...(threadId ? { thread_id: threadId } : {}),
            },
          });
        }
      }
    } catch (error) {
      const feishuErr = extractFeishuError(error);
      if (feishuErr) {
        console.warn(`Plain text message rejected by Feishu [${feishuErr.code}]: ${feishuErr.msg}`);
        throw new FeishuSendError(feishuErr.code, feishuErr.msg, text);
      }
      console.warn('Plain text message failed (non-Feishu-API error), trying fallback:', error);
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
        await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
            msg_type: 'interactive',
            content,
          },
        });
      } else {
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
      const feishuErr = extractFeishuError(error);
      if (feishuErr) {
        console.warn(`Interactive card rejected by Feishu [${feishuErr.code}]: ${feishuErr.msg}`);
        throw new FeishuSendError(feishuErr.code, feishuErr.msg, text);
      }
      console.warn('Interactive card message failed (non-content error), fallback to plain text:', error);
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
      let idx = remaining.lastIndexOf('\n\n', maxLen);
      if (idx < maxLen * 0.3) {
        idx = remaining.lastIndexOf('\n', maxLen);
      }
      if (idx < maxLen * 0.3) {
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
        await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
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
    for (const [id, ts] of this.messageCache.entries()) {
      if (now - ts > 30 * 60 * 1000) {
        this.messageCache.delete(id);
      }
    }
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
    // 优先从 identityResolver 缓存中获取真实姓名
    if (this.identityResolver) {
      const cached = this.identityResolver.getCached(openId);
      if (cached && cached.name) return cached.name;
    }
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

    const maxFileSize = options?.maxFileSize || 10 * 1024 * 1024;

    try {
      if (!existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const stats = statSync(filePath);
      if (stats.size > maxFileSize) {
        return { success: false, error: `File too large: ${stats.size} bytes (max: ${maxFileSize} bytes)` };
      }

      const ext = extname(filePath).toLowerCase();
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
      if (!allowedExtensions.includes(ext)) {
        return { success: false, error: `Unsupported file type: ${ext}` };
      }

      const fileBuffer = readFileSync(filePath);

      const result = await this.client.im.image.create({
        data: {
          image: fileBuffer,
          image_type: 'message',
        },
      });

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

      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType && !allowedContentTypes.includes(contentType)) {
        return { success: false, error: `Unsupported content type: ${contentType}` };
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxFileSize) {
        return {
          success: false,
          error: `File too large: ${contentLength} bytes (max: ${maxFileSize} bytes)`,
        };
      }

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

    const sorted = [...replacements.keys()]
      .sort((a, b) => b.length - a.length);

    const escaped = sorted
      .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    const masterPattern = new RegExp(
      `(!\\[[^\\]]*\\]\\()` +
      `(${escaped.join('|')})` +
      `(\\))` +
      `|(<img\\s[^>]*?src=["'])` +
      `(${escaped.join('|')})` +
      `(["'][^>]*?>)` +
      `|(${escaped.join('|')})`,
      'gi'
    );

    const processedText = text.replace(masterPattern, (...args) => {
      if (args[1] && args[2]) {
        const key = replacements.get(args[2]);
        return key ? `${args[1]}${key}${args[3]}` : args[0];
      }
      if (args[4] && args[5]) {
        const key = replacements.get(args[5]);
        return key ? `${args[4]}${key}${args[6]}` : args[0];
      }
      if (args[7]) {
        const key = replacements.get(args[7]);
        return key ? `![](${key})` : args[0];
      }
      return args[0];
    });

    return { processedText, imageKeys, errors };
  }

  private async resolveAndUpload(imagePath: string): Promise<ImageUploadResult> {
    if (imagePath.startsWith('file://')) {
      const localPath = fileURLToPath(imagePath);
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
      const processResult = await this.processContentWithImages(text);

      if (processResult.errors.length > 0) {
        console.warn('Some images failed to upload:', processResult.errors);
      }

      await this.sendMessage(chatId, processResult.processedText);

      console.log(`Message with processed content sent to chat ${chatId}`);
    } catch (error) {
      console.error('Failed to send message with processed content:', error);
      await this.sendMessage(chatId, text);
    }
  }

  /**
   * 下载飞书图片/文件
   *
   * @param messageId 消息ID
   * @param fileKey 文件key（用于messageResource.get API）
   * @param filePrefix 文件名前缀（如 imageKey、fileKey）
   * @param type 文件类型
   * @param targetDir 目标目录（必传，由 bridge 层提供 session files 路径）
   * @returns 下载后的本地文件路径
   */
  async downloadFile(
    messageId: string,
    fileKey: string,
    filePrefix: string,
    type: 'image' | 'file',
    targetDir: string,
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    try {
      const imageDir = targetDir;
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

      const fileName = `${filePrefix || fileKey}${getExtFromContentType(response.headers['Content-Type'] || response.headers['content-type'] || '')}`;
      const filePath = join(imageDir, fileName);

      await response.writeFile(filePath);

      return filePath;
    } catch (error) {
      console.error('下载飞书图片失败:', error);
      throw error;
    }
  }

  /**
   * 创建交互式卡片消息并返回 message_id
   */
  async createInteractiveCard(
    chatId: string,
    cardJson: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<string | null> {
    if (!this.client) {
      console.warn('Feishu client not initialized');
      return null;
    }

    try {
      let result: any;

      if (replyMessageId) {
        result = await this.client.im.message.reply({
          path: { message_id: replyMessageId },
          data: {
            msg_type: 'interactive',
            content: cardJson,
          },
        });
      } else {
        result = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
            ...(threadId ? { thread_id: threadId } : {}),
          },
        });
      }

      const messageId = result?.data?.message_id;
      if (messageId) {
        return messageId;
      }

      console.warn('⚠️ createInteractiveCard: no message_id in response');
      return null;
    } catch (error) {
      const feishuErr = extractFeishuError(error);
      if (feishuErr) {
        console.error(`❌ createInteractiveCard rejected [${feishuErr.code}]: ${feishuErr.msg}`);
        throw new FeishuSendError(feishuErr.code, feishuErr.msg, cardJson);
      }
      console.error('❌ createInteractiveCard failed:', error);
      return null;
    }
  }

  /**
   * Patch 更新已有的交互式卡片消息
   */
  async patchInteractiveCard(
    messageId: string,
    cardJson: string,
  ): Promise<boolean> {
    if (!this.client) {
      console.warn('Feishu client not initialized');
      return false;
    }

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: cardJson,
        },
      });
      return true;
    } catch (error) {
      console.error(`❌ patchInteractiveCard failed [${messageId}]:`, error);
      return false;
    }
  }
}
