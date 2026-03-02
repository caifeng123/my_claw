export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface FeishuMessage {
  messageId: string;       // IMPORTANT: used as reply target for im.message.reply
  chatId: string;
  threadId?: string;       // NEW: thread ID, only present for thread/topic group messages
  senderId: string;
  senderName: string;
  content: string;
  messageType: string;
  timestamp: string;
  attachments?: string; // JSON string of attachment data
}

export interface ThreadContext {
  threadId: string;
  chatId: string;
  sessionId: string;
  lastActivityAt: number;
  messageCount: number;
}

export interface FeishuConnection {
  connect(onMessage: (message: FeishuMessage) => void): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string, messageId?: string, threadId?: string): Promise<void>;  // MODIFIED: added messageId for reply, threadId for context
  sendTyping(chatId: string, isTyping: boolean, threadId?: string): Promise<void>;  // MODIFIED: threadId kept for forward compat, ignored in impl
  isConnected(): boolean;
}

export interface FeishuServiceConfig {
  appId: string;
  appSecret: string;
  onMessage?: (message: FeishuMessage) => void;
  onError?: (error: Error) => void;
}

// 图片上传选项
export interface ImageUploadOptions {
  timeout?: number; // 超时时间（毫秒）
  maxFileSize?: number; // 最大文件大小（字节）
}

// 图片上传结果
export interface ImageUploadResult {
  success: boolean;
  imageKey?: string; // 上传成功后的图片key
  error?: string; // 错误信息
}

// 支持图片的消息接口
export interface FeishuMessageWithImage extends FeishuMessage {
  imageKeys?: string[]; // 图片键值列表
}

// 内容处理结果
export interface ContentProcessResult {
  processedText: string; // 处理后的文本（图片路径替换为Markdown链接）
  imageKeys: string[]; // 上传的图片键值列表
  errors: string[]; // 处理过程中遇到的错误
}