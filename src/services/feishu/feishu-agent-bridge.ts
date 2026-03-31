/**
 * FeishuAgentBridge V4.4
 * 新增:
 *   - 图片分析缓存：vision-analyzer Sub-Agent 分析完成后自动将结果写入 images.json
 *   - JSONL 中只存图片路径 ![image](path)，分析结果存在独立可覆盖的缓存中
 *   - context-builder 加载历史时从缓存替换图片引用，避免重复调用 Sub-Agent
 *   - 首次分析和重新分析均通过 onToolUseStart/Stop 回调自动处理
 *
 * 基于 V4.3：引用消息读取 + 文件下载迁移到 session 目录 + 流式卡片支持
 */

import { FeishuService, FeishuSendError } from './feishu-service.js';
import { StreamingCardRenderer } from './streaming-card-renderer.js';
import type { FeishuConnectionConfig, FeishuMessage, ThreadContext } from './types.js';
import { formatMentionsForPrompt } from './mention-utils.js';
import { getAgentEngine } from '../../core/agent-registry.js';
import type { EventHandlers } from '@/core/agent/types/agent.js';
import { writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { ClaudeEngine } from '@/core/agent/engine/claude-engine.js';
import { getFilesDir } from '../../utils/paths.js';
import { relative, join } from 'path';
import type { ImageAnalysisEntry } from '../../core/memory/conversation-store.js';

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
  /** 是否启用流式卡片 (Create + Patch)，默认 false */
  enableStreamingCard?: boolean;
}


/**
 * 在目录中查找包含指定 fileKey 的已有文件
 * 用于图片/文件去重，避免 Date.now() 导致的重复下载
 * @returns 完整路径，未找到则返回 null
 */
function findExistingFileByKey(dir: string, fileKey: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir);
    const match = files.find(f => f.includes(fileKey));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

export class FeishuAgentBridge {
  private feishuService: FeishuService;
  private config: FeishuAgentBridgeConfig;
  private claudeEngine: ClaudeEngine;
  private chatToSessionMap = new Map<string, string>();
  private threadContexts = new Map<string, ThreadContext>();
  private isConnected = false;
  private processingChats = new Set<string>();
  private activeRenderers = new Map<string, StreamingCardRenderer>();

  constructor(config: FeishuAgentBridgeConfig) {
    this.claudeEngine = new ClaudeEngine()
    this.config = {
      sessionPrefix: 'feishu_',
      enableStreaming: true,
      showTypingIndicator: true,
      enableStreamingCard: false,
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

  // ==================== NEW: 暴露文件发送能力 ====================

  /**
   * 上传本地文件并发送到飞书聊天
   */
  async sendFileToChat(
    chatId: string,
    filePath: string,
    replyMessageId?: string,
    threadId?: string,
    fileType?: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream',
  ): Promise<void> {
    await this.feishuService.uploadAndSendFile(chatId, filePath, replyMessageId, threadId, fileType);
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

    let commitMessage = '';
    try {
      const diff = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8' }).trim();
      const summary = [diff, untracked ? `新增文件:\n${untracked}` : ''].filter(Boolean).join('\n\n');

      if (summary) {
        commitMessage = 'auto: verified restart commit';
        const result = await this.claudeEngine.executeClaudeQueryRaw(
          '你是一个专业的 Git 提交消息生成器。根据代码变更，生成一个简洁的、符合 Git 提交规范的 commit message。只返回 commit message 本身，不要包含其他说明。',
          `请根据以下代码变更生成一个简洁的 commit message:\n\n${summary}`,
        );
        commitMessage = result.content.trim()
        console.log(`📝 生成的 commit message: ${commitMessage}`);
      }
    } catch (e) {
      console.warn('⚠️ 生成 commit message 失败，使用默认值:', e);
    }

    await this.feishuService.sendMessage(
      message.chatId,
      `${commitMessage ? `📝 变更摘要：${commitMessage}\n\n` : ''}🚀 正在重启服务，请稍候...`,
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
 * 处理 /new 指令 - 清空当前 session，开启新对话
 */
private async handleNewCommand(message: FeishuMessage): Promise<void> {
    console.log('🆕 收到 /new 指令，重置当前会话');

    const sessionId = this.getOrCreateSessionId(message.chatId, message.threadId);
    const agentEngine = getAgentEngine();

    const aborted = agentEngine.abortSession(sessionId);
    if (aborted) {
      console.log(`⏹️ 已中断会话 ${sessionId} 的进行中请求`);
    }

    const processingKey = message.threadId
      ? `${message.chatId}:${message.threadId}`
      : message.chatId;
    const renderer = this.activeRenderers.get(processingKey);
    if (renderer) {
      await renderer.onAborted();
      this.activeRenderers.delete(processingKey);
    }

    // 确保旧请求的 finally 块执行完毕，不会再写入 JSONL
    if (this.processingChats.has(processingKey)) {
      console.log(`⏳ 等待 ${processingKey} 的旧请求处理完毕...`);
      await this.waitForProcessingComplete(processingKey);
    }

    // === 现在安全地清空上下文 ===
    agentEngine.getConversationStore().deleteSession(sessionId);
    agentEngine.deleteSession(sessionId);

    agentEngine.createSession({
      sessionId,
      userId: message.chatId,
    });

    console.log(`✅ 会话已重置: ${sessionId}`);

    await this.feishuService.sendMessage(
      message.chatId,
      '✅ 已开启新会话，之前的对话上下文已清除。请开始新的对话吧！',
      message.messageId,
      message.threadId
    );
}

  /**
   * 处理 /stop 指令 - 中断当前 session 正在进行的请求
   * - 精确匹配 sessionId，失败后按 chatId 前缀遍历所有关联 session
   * - 中断成功后将流式卡片更新为灰色「用户已中断」状态
   */
  private async handleStopCommand(message: FeishuMessage): Promise<void> {
    const agentEngine = getAgentEngine();
    let aborted = false;
    let matchedProcessingKey: string | null = null;

    // 1. 精确匹配
    const sessionId = this.getOrCreateSessionId(message.chatId, message.threadId);
    aborted = agentEngine.abortSession(sessionId);
    if (aborted) {
      matchedProcessingKey = message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;
    }

    // 2. 精确匹配失败，按 chatId 前缀遍历
    if (!aborted) {
      for (const [key, sid] of this.chatToSessionMap.entries()) {
        if (key === sessionId) continue;
        if (key.startsWith(message.chatId)) {
          if (agentEngine.abortSession(sid)) {
            aborted = true;
            matchedProcessingKey = key;
            break;
          }
        }
      }
    }

    // 3. 更新流式卡片为「用户已中断」状态
    if (aborted && matchedProcessingKey) {
      const renderer = this.activeRenderers.get(matchedProcessingKey);
      if (renderer) {
        await renderer.onAborted();
        this.activeRenderers.delete(matchedProcessingKey);
      }
    }

    if (aborted) {
      await this.feishuService.sendMessage(
        message.chatId,
        '⏸️ 已中断当前对话，你可以继续发送新消息。',
        message.messageId,
        message.threadId
      );
    } else {
      await this.feishuService.sendMessage(
        message.chatId,
        '💡 当前没有正在进行的请求。',
        message.messageId,
        message.threadId
      );
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

  // ==================== 图片分析缓存 ====================

  /**
   * 追踪 vision-analyzer Sub-Agent 调用的图片路径
   * key: toolUseId, value: 从 Agent tool input.prompt 中提取的图片路径
   * 在 onToolUseStart 时记录，在 onToolUseStop 时查找并写入缓存
   */
  private pendingVisionAnalysis = new Map<string, string>()

  /** 清理超过 5 分钟未完成的 pending 条目，防止内存泄漏 */
  private cleanStalePendingAnalysis(): void {
    // Map 只存 toolUseId → path，无时间戳，用 size 兜底
    if (this.pendingVisionAnalysis.size > 50) {
      // 超过 50 个未完成的分析不正常，全部清理
      console.warn(`⚠️ pendingVisionAnalysis 异常堆积 (${this.pendingVisionAnalysis.size})，已清理`)
      this.pendingVisionAnalysis.clear()
    }
  }

  /**
   * 从 Agent tool 的 input 中提取 vision-analyzer 的图片路径
   */
  private extractImageKeyFromAgentInput(input: any): string | null {
    if (!input) return null
    // Agent tool 的 input 结构: { subagent_type: "vision-analyzer", prompt: "...image at <path>..." }
    const subagentType = input.subagent_type ?? input.type ?? ''
    if (!String(subagentType).includes('vision')) return null

    const prompt = String(input.prompt ?? '')
    // 从 prompt 中提取图片文件路径，再去掉扩展名得到 imageKey
    // 文件名格式: {imageKey}.ext (如 img_v3_xxx.jpg)
    const pathMatch = prompt.match(/(?:image|图片)\s+(?:at\s+)?([^\s,."']+\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif))/i)
    if (!pathMatch?.[1]) return null
    const filePath = pathMatch[1]
    // 取最后一段文件名，去掉扩展名即为 imageKey
    const basename = filePath.split('/').pop() ?? filePath
    return basename.replace(/\.[^.]+$/, '')
  }

  /**
   * 构建缓存写入逻辑（供 onToolUseStop 调用）
   * 检查 toolUseId 是否有对应的 pending vision analysis，有则写入缓存
   */
  private tryWriteImageCache(
    sessionId: string,
    toolUseId: string | undefined,
    result: any,
  ): void {
    if (!toolUseId) return

    const imageKey = this.pendingVisionAnalysis.get(toolUseId)
    if (!imageKey) return

    // 清理 pending 记录
    this.pendingVisionAnalysis.delete(toolUseId)

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    // 基本校验：结果应包含分析内容
    if (resultStr.length < 20) return

    const entry: ImageAnalysisEntry = {
      result: resultStr,
      analyzedAt: Date.now(),
      context: 'auto-cached from vision-analyzer',
    }

    try {
      getAgentEngine().getConversationStore().updateImageCacheEntry(sessionId, imageKey, entry)
      console.log(`🖼️ 图片分析缓存已写入: ${imageKey} (${resultStr.length} 字符)`)
    } catch (error) {
      console.error(`❌ 写入图片分析缓存失败: ${imageKey}`, error)
    }
  }

  /**
   * 处理飞书消息
   * V4.4: 新增图片分析缓存写入
   */
  private async handleFeishuMessage(message: FeishuMessage): Promise<void> {
    console.log(`📨 Received Feishu message: ${message.senderName} -> ${message.content.substring(0, 50)}...`);

    if (!message.content.trim()) {
      return;
    }

    const trimmedContent = message.content.trim();
    // 去掉所有 @姓名(open_id) 提及后提取指令（群聊中可能有多个 @）
    const command = trimmedContent.replace(/@[^@()]+\([^)]*\)/g, '').trim();

    if (command === '/restart') {
      await this.handleRestartCommand(message);
      return;
    }

    if (command === '/new') {
      await this.handleNewCommand(message);
      return;
    }

    if (command === '/stop') {
      await this.handleStopCommand(message);
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

      // ==================== NEW: 异步解析发信人身份 ====================
      // 确保 Agent 知道当前对话的用户是谁（姓名而非 openId）
      const identityResolver = this.feishuService.getIdentityResolver();
      if (identityResolver && message.senderId) {
        try {
          const userInfo = await identityResolver.resolveUser(message.senderId);
          if (userInfo?.name) {
            message.senderName = userInfo.name;
            console.log(`👤 发信人身份已解析: ${message.senderId} → ${userInfo.name}`);
          }
        } catch (err) {
          console.warn(`⚠️ 解析发信人身份失败: ${message.senderId}`, err);
        }
      }


      // ==================== NEW: 异步获取引用消息内容 ====================
      let quotedContent: string | null = null;
      if (message.parentId) {
        try {
          const quoted = await this.feishuService.getQuotedMessageContent(message.parentId);
          quotedContent = quoted.text;

          if (quotedContent) {
            message.quotedContent = quotedContent;
          }

          // 引用消息中的图片：下载到 session 目录
          // 注意：quoted.text 中已包含 ![image]({{FILE:imageKey}}) 占位符，
          // 只需下载文件并将路径加入 downloadedPaths，后面统一由占位符替换逻辑处理。
          if (quoted.imageKeys && quoted.imageKeys.length > 0 && quoted.messageId) {
            const quotedFilesDir = getFilesDir(sessionId);
            // 将引用消息的 imageKeys 合并到 message.imageKeys（用于后续 pathByKey 映射）
            if (!message.imageKeys) message.imageKeys = [];

            for (const imageKey of quoted.imageKeys) {
              const key = imageKey as string;
              // 避免重复添加（引用图片和当前消息图片可能相同）
              if (!message.imageKeys.includes(key)) {
                message.imageKeys.push(key);
              }

              // 检查磁盘是否已存在（跨请求去重）
              const existingFile = findExistingFileByKey(quotedFilesDir, key);
              if (existingFile) {
                if (!message.downloadedPaths) message.downloadedPaths = [];
                if (!message.downloadedPaths.includes(existingFile)) {
                  message.downloadedPaths.push(existingFile);
                }
                console.log(`📎 引用图片已存在，跳过下载: ${existingFile}`);
                continue;
              }

              try {
                const filePath = await this.feishuService.downloadFile(
                  quoted.messageId,
                  key,
                  key,
                  'image',
                  quotedFilesDir,
                );
                if (!message.downloadedPaths) message.downloadedPaths = [];
                message.downloadedPaths.push(filePath);
                console.log(`📥 引用图片已下载: ${filePath}`);
              } catch (downloadError) {
                console.error(`下载引用图片失败: ${key}`, downloadError);
              }
            }
          }
        } catch (error: any) {
          console.error(`获取引用消息失败: ${message.parentId}, error=${error?.message || error}`);
        }
      }

      // ==================== 不支持的引用消息类型：直接回复提示，不走 AI ====================
      if (quotedContent === '暂不支持读取卡片详细内容') {
        await this.feishuService.sendMessage(message.chatId, quotedContent, message.messageId, message.threadId);
        return;
      }

      // ==================== NEW: 文件下载到 session 目录 ====================
      const downloadedPaths: string[] = [];
      const filesDir = getFilesDir(sessionId);

      // 下载图片到 session 目录（使用 imageKey 作为稳定文件名，避免重复下载）
      if (message.imageKeys && message.imageKeys.length > 0) {
        for (let i = 0; i < message.imageKeys.length; i++) {
          const imageKey = message.imageKeys[i] as string;
          // 先检查是否已存在
          const existingImg = findExistingFileByKey(filesDir, imageKey);
          if (existingImg) {
            downloadedPaths.push(existingImg);
            console.log(`📎 图片已存在，跳过下载: ${existingImg}`);
            continue;
          }
          try {
            const filePath = await this.feishuService.downloadFile(
              message.messageId,
              imageKey,
              imageKey,
              'image',
              filesDir,
            );
            downloadedPaths.push(filePath);
            console.log(`📥 图片已下载到 session 目录: ${filePath}`);
          } catch (downloadError) {
            console.error(`📥 下载图片失败: ${imageKey}`, downloadError);
          }
        }
      }

      // 下载文件到 session 目录（使用 fileKey 作为稳定文件名，避免重复下载）
      if (message.fileKeys && message.fileKeys.length > 0) {
        for (let i = 0; i < message.fileKeys.length; i++) {
          const fileKey = message.fileKeys[i] as string;
          // 先检查是否已存在
          const existingFile = findExistingFileByKey(filesDir, fileKey);
          if (existingFile) {
            downloadedPaths.push(existingFile);
            console.log(`📎 文件已存在，跳过下载: ${existingFile}`);
            continue;
          }
          try {
            const filePath = await this.feishuService.downloadFile(
              message.messageId,
              fileKey,
              `file-${fileKey}`,
              'file',
              filesDir,
            );
            downloadedPaths.push(filePath);
            console.log(`📥 文件已下载到 session 目录: ${filePath}`);
          } catch (downloadError) {
            console.error(`📥 下载文件失败: ${fileKey}`, downloadError);
          }
        }
      }

      // 将下载路径回写到 message 对象，并将占位符替换为实际本地路径
      if (downloadedPaths.length > 0) {
        message.downloadedPaths = downloadedPaths;

        // 构建占位符 → 实际路径的映射（直接用 imageKey/fileKey 作为 key）
        const toRelative = (p: string) => {
          const rel = relative(process.cwd(), p);
          return rel.startsWith('..') ? p : rel;
        };
        const pathByKey = new Map<string, string>();
        for (const p of downloadedPaths) {
          // 从路径中提取 imageKey/fileKey（文件名格式: img-{key}.ext 或 file-{key}.ext）
          const allKeys = [...(message.imageKeys || []), ...(message.fileKeys || [])];
          for (const key of allKeys) {
            if (p.includes(key as string)) {
              pathByKey.set(key as string, p);
              break;
            }
          }
        }

        // 替换占位符为实际路径
        // 图片占位符: ![image]({{FILE:key}}) → ![image](key)
        // JSONL 中只存 imageKey，context-builder 读取时:
        //   - 缓存命中 → 替换为纯文本分析结果
        //   - 缓存未命中 → 按 sessionId 扫描 files/ 目录还原完整路径
        // 文件占位符: {{FILE:key}} → 完整相对路径（非图片文件无缓存机制，需要完整路径）
        if (message.quotedContent) {
          message.quotedContent = message.quotedContent.replace(
            /!\[image\]\(\{\{FILE:([^}]+)\}\}\)/g,
            (_match: string, key: string) => `![image](${key})`
          ).replace(
            /\{\{FILE:([^}]+)\}\}/g,
            (_match: string, key: string) => {
              const p = pathByKey.get(key);
              return p ? toRelative(p) : '';
            }
          );
        }

        message.content = message.content.replace(
          /!\[image\]\(\{\{FILE:([^}]+)\}\}\)/g,
          (_match: string, key: string) => `![image](${key})`
        ).replace(
          /\{\{FILE:([^}]+)\}\}/g,
          (_match: string, key: string) => {
            const p = pathByKey.get(key);
            return p ? toRelative(p) : '';
          }
        ).trim();
      }

      if (this.config.showTypingIndicator) {
        await this.feishuService.sendTyping(message.chatId, true, message.threadId);
      }

      try {
        if (this.config.enableStreamingCard) {
          await this.handleStreamingCardResponse(sessionId, message);
        } else if (this.config.enableStreaming) {
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

  // AI 修复重试配置
  private static readonly AI_FIX_MAX_RETRIES = 2;

  /**
   * 使用 AI 修复被飞书审核拒绝的消息内容
   */
  private async fixContentWithAI(
    originalContent: string,
    feishuErrorCode: number,
    feishuErrorMsg: string,
  ): Promise<string> {
    console.log(`🔧 AI 修复开始 [错误码=${feishuErrorCode}]: ${feishuErrorMsg}`);

    const systemPrompt = `你是一个消息内容修复助手。用户通过飞书发送消息时被飞书内容审核拦截了。
你需要根据飞书返回的错误信息，修复消息内容使其能通过审核，同时尽量保留原始含义。

修复规则：
1. 如果错误提示包含敏感数据（如手机号、身份证号、银行卡号、密码等），将这些内容用脱敏占位符替换，例如：
   - 手机号 13812345678 → 138****5678
   - 密码内容 → [已隐藏]
   - 身份证号 → [已脱敏]
2. 如果错误提示内容违规，重写相关段落使其合规
3. 保留消息的整体结构和格式（Markdown 标题、列表等）
4. 不要添加额外的解释，只返回修复后的完整消息内容`;

    const userQuery = `飞书发送失败，错误信息：
- 错误码: ${feishuErrorCode}
- 错误描述: ${feishuErrorMsg}

请修复以下消息内容，使其能通过飞书审核：

---
${originalContent}
---

请直接返回修复后的完整消息内容，不要包含任何额外说明：`;

    try {
      const result = await this.claudeEngine.executeClaudeQueryRaw(systemPrompt, userQuery);
      const fixedContent = result.content.trim();
      console.log(`✅ AI 修复完成，原内容 ${originalContent.length} 字符 → 修复后 ${fixedContent.length} 字符`);
      return fixedContent;
    } catch (error) {
      console.error('❌ AI 修复失败:', error);
      return '⚠️ 消息内容因包含敏感信息无法发送，请直接联系我获取详细信息。';
    }
  }

  /**
   * 发送消息，如果因内容审核失败则使用 AI 修复后重试
   */
  private async sendMessageWithAIFix(
    chatId: string,
    text: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<void> {
    let currentContent = text;
    let retries = 0;

    while (retries <= FeishuAgentBridge.AI_FIX_MAX_RETRIES) {
      try {
        await this.feishuService.sendMessage(chatId, currentContent, replyMessageId, threadId);
        return;
      } catch (error) {
        if (error instanceof FeishuSendError && retries < FeishuAgentBridge.AI_FIX_MAX_RETRIES) {
          retries++;
          console.warn(`⚠️ 消息发送被飞书拒绝 [${error.code}]: ${error.feishuMsg}，正在进行第 ${retries} 次 AI 修复...`);
          currentContent = await this.fixContentWithAI(
            currentContent,
            error.code,
            error.feishuMsg,
          );
        } else {
          if (error instanceof FeishuSendError) {
            console.error(`❌ AI 修复 ${retries} 次后仍然失败，发送通用提示`);
            try {
              await this.feishuService.sendMessage(
                chatId,
                '⚠️ 消息内容因包含敏感信息无法发送（已尝试自动修复但仍未通过审核）。请直接与我沟通获取详细信息，或换一种方式描述您的需求。',
                replyMessageId,
                threadId,
              );
            } catch (finalError) {
              console.error('❌ 最终降级消息也发送失败:', finalError);
            }
          } else {
            console.error('❌ 消息发送失败（非内容审核错误）:', error);
          }
          return;
        }
      }
    }
  }

  // ==================== NEW: 构建 enrichedContent，注入引用上下文 ====================

  /**
   * 构建飞书会话上下文（注入到 systemPrompt，而非 userMessage）
   * 
   * 放在 systemPrompt 中的好处：
   *   1. Agent 不会把系统上下文当作用户对话内容复述给用户
   *   2. systemPrompt 层级的指令遵从度更高
   *   3. chatId/senderId 等内部 ID 不会泄露到回复中
   *
   * [RESUME 优化]:
   *   - 新会话: 注入完整上下文 (chatId, threadId, senderId)
   *   - 续接会话: 仅注入 senderId（chatId/threadId 已在 SDK session 中）
   */
  buildSessionContext(message: FeishuMessage, isNewSession: boolean): string {
    const parts: string[] = [];

    // bot 身份信息：让 agent 知道自己是谁
    const botOpenId = this.feishuService.getBotOpenId();
    const botName = this.feishuService.getBotName();
    if (botOpenId) {
      parts.push(`[Bot 身份] 你是飞书机器人「${botName || 'Bot'}」(open_id: ${botOpenId})。当用户消息中出现 @${botName || 'Bot'}(${botOpenId}) 时，说明用户在对你说话。`);
    }

    // 会话上下文（内部 ID，不向用户展示）
    // 发信人身份已通过 buildEnrichedContent 以 @姓名(open_id): 前缀注入到用户消息中
    if (isNewSession) {
      const ctxParts = [`chatId="${message.chatId}"`];
      if (message.threadId) {
        ctxParts.push(`threadId="${message.threadId}"`);
      }
      ctxParts.push(`senderId="${message.senderId}"`);
      parts.push(`[飞书会话上下文] ${ctxParts.join(', ')}。这些 ID 仅供工具调用时使用，严禁在回复中向用户展示。`);
    } else {
      parts.push(`[飞书会话上下文] 当前消息发送者: senderId="${message.senderId}"。此 ID 仅供内部使用，严禁在回复中展示。`);
    }

    // mentions 上下文：告知 agent 本次消息中有哪些人被 @
    const mentionPrompt = formatMentionsForPrompt(message.mentions);
    if (mentionPrompt) {
      parts.push(mentionPrompt);
    }

    return parts.join('\n');
  }

  /**
   * 构建发送给 Agent 的 enrichedContent
   * 仅包含：引用消息内容 + 用户消息（不再包含系统上下文）
   */
  private buildEnrichedContent(message: FeishuMessage): string {
    const parts: string[] = [];

    // 引用消息作为前缀
    if (message.quotedContent) {
      const quoted = '> ' + message.quotedContent.split('\n').join('\n> ');
      parts.push(quoted);
    }

    // 在用户消息前加发信人标识，格式与 mentions 一致: @姓名(open_id)
    const senderPrefix = message.senderName && message.senderId
      ? `@${message.senderName}(${message.senderId}): `
      : '';
    parts.push(senderPrefix + message.content);
    return parts.join('\n\n');
  }

  /**
   * 处理流式卡片回复 (V4.4: 使用 buildEnrichedContent + 图片缓存覆盖)
   */
  private async handleStreamingCardResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    let fullResponse = '';
    const replyMessageId = message.threadId ? message.messageId : undefined;

    const renderer = new StreamingCardRenderer(
      {
        createInteractiveCard: (chatId, cardJson, replyMsgId, threadId) =>
          this.feishuService.createInteractiveCard(chatId, cardJson, replyMsgId, threadId),
        patchInteractiveCard: (messageId, cardJson) =>
          this.feishuService.patchInteractiveCard(messageId, cardJson),
      },
      message.chatId,
      replyMessageId,
      message.threadId,
    );

    // 设置完成时 @ 提问者
    if (message.senderId) {
      renderer.setMentionUser(message.senderId);
    }

    // 注册活跃 renderer，供 /stop 时调用 onAborted
    const processingKey = message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;
    this.activeRenderers.set(processingKey, renderer);

    const eventHandlers: EventHandlers = {
      onContentStart: async () => {
        await renderer.init()
      },

      onThinkingDelta: async (thinkingText: string) => {
        await renderer.onThinking(thinkingText);
      },

      onThinkingStop: async () => {
        await renderer.onThinkingStop();
      },

      onToolUseStart: async (toolName: string, input?: any, parentToolUseId?: string | null, toolUseId?: string) => {
        await renderer.onToolStart(toolName, input, parentToolUseId, toolUseId);

        // V4.4: 追踪 vision-analyzer 调用，记录图片路径
        if (toolName === 'Agent' && toolUseId) {
          const imgKey = this.extractImageKeyFromAgentInput(input);
          if (imgKey) {
            this.cleanStalePendingAnalysis();
            this.pendingVisionAnalysis.set(toolUseId, imgKey);
          }
        }
      },

      onToolUseStop: async (toolName: string, result: any, parentToolUseId?: string | null, toolUseId?: string) => {
        await renderer.onToolEnd(toolName, result, parentToolUseId);

        // V4.4: vision-analyzer 完成 → 自动写入/覆盖图片分析缓存
        // toolUseId 即 onToolUseStart 中存入 pendingVisionAnalysis 的 key
        this.tryWriteImageCache(sessionId, toolUseId, result);
      },

      onContentDelta: async (textDelta: string) => {
        fullResponse += textDelta;
        await renderer.onContentDelta(textDelta);
      },

      onContentStop: async () => {
        if (renderer.isFallback()) {
          if (fullResponse) {
            await this.sendMessageWithAIFix(message.chatId, fullResponse, replyMessageId, message.threadId);
          }
        } else {
          await renderer.onComplete();

          if (renderer.isContentTruncated() && fullResponse) {
            await this.sendMessageWithAIFix(message.chatId, fullResponse, replyMessageId, message.threadId);
          }
        }
        this.activeRenderers.delete(processingKey);
      },

      onError: async (error: string) => {
        if (renderer.isFallback()) {
          await this.sendErrorResponse(message.chatId, new Error(error), replyMessageId, message.threadId);
        } else {
          await renderer.onError(error);
        }
        this.activeRenderers.delete(processingKey);
      },
    };

    const isNewSession = !getAgentEngine().hasResumeSession(sessionId);
    const sessionContext = this.buildSessionContext(message, isNewSession);
    const enrichedContent = this.buildEnrichedContent(message);

    await getAgentEngine().sendMessageStream(sessionId, enrichedContent, message.senderId, eventHandlers, sessionContext);
  }

  /**
   * 处理流式回复 (V4.4: 使用 buildEnrichedContent + 图片缓存覆盖)
   */
  private async handleStreamingResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    let fullResponse = '';

    const replyMessageId = message.threadId ? message.messageId : undefined;

    const eventHandlers: EventHandlers = {
      onContentDelta: async (textDelta: string) => {
        fullResponse += textDelta;
      },
      onToolUseStart: async (toolName: string, input?: any, _parentToolUseId?: string | null, toolUseId?: string) => {
        // V4.4: 追踪 vision-analyzer 调用
        if (toolName === 'Agent' && toolUseId) {
          const imgKey = this.extractImageKeyFromAgentInput(input);
          if (imgKey) {
            this.cleanStalePendingAnalysis();
            this.pendingVisionAnalysis.set(toolUseId, imgKey);
          }
        }
      },
      onToolUseStop: async (toolName: string, result: any, parentToolUseId?: string | null, toolUseId?: string) => {
        // V4.4: vision-analyzer 完成 → 自动写入/覆盖图片分析缓存
        this.tryWriteImageCache(sessionId, toolUseId, result);
      },
      onContentStop: async () => {
        if (fullResponse) {
          await this.sendMessageWithAIFix(message.chatId, fullResponse, replyMessageId, message.threadId);
          console.log(`✅ Streaming response completed: ${fullResponse.length} chars`);
        }
      },
      onError: async (error: string) => {
        console.error('Streaming response error:', error);
        this.sendErrorResponse(message.chatId, new Error(error), replyMessageId, message.threadId).catch(console.error);
      },
    };

    const isNewSession = !getAgentEngine().hasResumeSession(sessionId);
    const sessionContext = this.buildSessionContext(message, isNewSession);
    const enrichedContent = this.buildEnrichedContent(message);

    await getAgentEngine().sendMessageStream(sessionId, enrichedContent, message.senderId, eventHandlers, sessionContext);
  }

  /**
   * 处理常规回复 (V4.4: 使用 buildEnrichedContent)
   */
  private async handleRegularResponse(sessionId: string, message: FeishuMessage): Promise<void> {
    const isNewSession = !getAgentEngine().hasResumeSession(sessionId);
    const sessionContext = this.buildSessionContext(message, isNewSession);
    const enrichedContent = this.buildEnrichedContent(message);
    const response = await getAgentEngine().sendMessage(sessionId, enrichedContent, message.senderId, sessionContext);

    const replyMessageId = message.threadId ? message.messageId : undefined;

    if (response && response.content) {
      await this.sendMessageWithAIFix(message.chatId, response.content, replyMessageId, message.threadId);
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

    getAgentEngine().createSession({
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
