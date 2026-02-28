export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  messageType: string;
  timestamp: string;
  attachments?: string; // JSON string of attachment data
}

export interface FeishuConnection {
  connect(onMessage: (message: FeishuMessage) => void): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
}

export interface FeishuServiceConfig {
  appId: string;
  appSecret: string;
  onMessage?: (message: FeishuMessage) => void;
  onError?: (error: Error) => void;
}