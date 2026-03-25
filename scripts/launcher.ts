#!/usr/bin/env node
/**
 * Launcher - 服务启动器
 * 作为父进程管理业务服务子进程，取代 tsx watch 模式
 * 功能：
 * - 不自动热更新（Claude Code 修改文件不会导致服务重启）
 * - 手动触发重启（用户发送 /restart 指令）
 * - 启动失败自动回滚（stash 暂存问题代码，恢复到上次 commit）
 * - 跨重启状态通知（通过 .restart-state.json 文件）
 *
 * 状态管理：统一使用 STATE_FILE 作为单一数据源
 * - 有文件 = 正在重启流程中
 * - 没文件 = 首次启动 or 一切正常
 *
 * Git 策略：commit 里永远是验证通过的代码
 * - /restart → 直接用工作区新代码试启动（不 commit）
 * - 成功 → git add -A && git commit（新代码入库）
 * - 失败 → git stash push -u（保留新代码）→ 用 commit 里的旧代码启动
 * - 回滚成功 → git stash pop（新代码放回工作区继续修改）
 */

import { fork, execSync, ChildProcess, execFileSync } from 'child_process';
import { DeviceAuthClient } from '../src/services/feishu/device-auth.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置
const STATE_FILE = '.restart-state.json';
const READY_TIMEOUT = 30000;
const MAX_RESTART_RETRIES = 1;
const GRACEFUL_SHUTDOWN_TIMEOUT = 5000;

// 状态类型
interface RestartState {
  chatIds: string[];
  messageIds: string[];
  status: 'restarting' | 'rollback' | 'success';
  timestamp: number;
  error?: string;
  stashCreated?: boolean;
  commitMessage?: string;
}

// 子进程管理器
class Launcher {
  private child: ChildProcess | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private restartRetries = 0;
  private isShuttingDown = false;
  private isRestarting = false;

  constructor() {
    this.setupSignalHandlers();
  }

  // ==================== 状态文件操作（单一数据源）====================

  private readState(): RestartState | null {
    try {
      if (existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('⚠️ 读取状态文件失败:', e);
      this.cleanupStateFile();
    }
    return null;
  }

  private writeState(state: RestartState): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('❌ 写入状态文件失败:', e);
    }
  }

  private updateState(patch: Partial<RestartState>): void {
    const state = this.readState();
    if (state) {
      this.writeState({ ...state, ...patch });
    }
  }

  private cleanupStateFile(): void {
    try {
      if (existsSync(STATE_FILE)) {
        unlinkSync(STATE_FILE);
        console.log('🧹 状态文件已清理');
      }
    } catch (e) {
      console.warn('⚠️ 清理状态文件失败:', e);
    }
  }

  // ==================== 生命周期 ====================

  async start(): Promise<void> {
    console.log('🚀 Launcher 启动中...');
    console.log(`📁 工作目录: ${process.cwd()}`);
    console.log(`📄 状态文件: ${STATE_FILE}`);

    const existingState = this.readState();
    if (existingState) {
      console.log('📄 发现未处理的状态文件:', existingState);
    }

    // Token 预检：启动前确认飞书 User Token 可用
    this.checkFeishuToken();

    await this.forkChild();
  }

  private async forkChild(): Promise<void> {
    if (this.child) {
      console.log('⚠️ 子进程已存在，先停止旧进程');
      await this.killChild();
    }

    console.log('📤 正在启动子进程...');

    this.child = fork(join(__dirname, '../src', 'index.ts'), [], {
      execArgv: ['--import', 'tsx/esm'],
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });

    this.child.on('message', (msg: any) => {
      this.handleChildMessage(msg);
    });

    this.child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal);
    });

    this.child.on('error', (err) => {
      console.error('❌ 子进程错误:', err);
    });

    this.readyTimeout = setTimeout(() => {
      console.error('⏱️ 子进程启动超时（未收到 ready 信号）');
      this.handleStartupFailure(new Error('启动超时'));
    }, READY_TIMEOUT);
  }

  // ==================== 消息处理 ====================

  private handleChildMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ready':
        this.handleChildReady();
        break;
      case 'restart':
        this.handleRestartRequest();
        break;
      case 'error':
        console.error('📨 子进程报告错误:', msg.error);
        break;
      default:
        console.log('📨 收到子进程消息:', msg);
    }
  }

  /**
   * 子进程就绪处理
   * - 普通重启成功：commit 新代码（盖章"能跑"）
   * - 回滚后成功：stash pop 恢复新代码到工作区继续修改
   */
  private async handleChildReady(): Promise<void> {
    console.log('✅ 子进程已就绪');

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.restartRetries = 0;

    const state = this.readState();
    if (!state) return;

    if (state.status === 'restarting') {
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
        if (status) {
          const msg = (state.commitMessage || 'auto: verified restart commit').replace(/"/g, '\\"');
          console.log(`📦 新代码验证通过，commit: ${msg}`);
          execFileSync('git', ['add', '-A'], { stdio: 'inherit' });
          execFileSync('git', ['commit', '-m', msg], { stdio: 'inherit' });
          console.log('✅ 已 commit');
        }
      } catch (e) {
        console.warn('⚠️ 自动 commit 失败:', e);
      }
      this.updateState({ status: 'success' });
    } else if (state.status === 'rollback') {
      // 回滚后启动成功，恢复 stash
      if (state.stashCreated) {
        this.restoreStash();
      }
      // 不改 status，保留 rollback → 通知子进程发 "⚠️ 已回滚"
    }

    this.notifyChildOfState();
    setTimeout(() => this.cleanupStateFile(), 3000);
  }

  /**
   * 处理重启请求
   * 不 commit，新代码留在工作区直接试启动
   */
  private handleRestartRequest(): void {
    console.log('🔄 收到子进程重启请求');

    if (!this.readState()) {
      console.warn('⚠️ 未发现状态文件，创建兜底状态');
      this.writeState({
        chatIds: [],
        messageIds: [],
        status: 'restarting',
        timestamp: Date.now(),
      });
    }

    this.performRestart();
  }

  // ==================== 重启与回滚 ====================

  private async performRestart(): Promise<void> {
    if (this.isRestarting) return;
    this.isRestarting = true;

    console.log('🔄 正在执行重启...');

    try {
      await this.killChild();
      await this.forkChild();
    } finally {
      this.isRestarting = false;
    }
  }

  private handleChildExit(code: number | null, signal: string | null): void {
    console.log(`📤 子进程退出，code: ${code}, signal: ${signal}`);

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.child = null;

    if (this.isShuttingDown || this.isRestarting) return;

    if (code === 0) {
      const state = this.readState();
      if (state?.status === 'restarting') {
        console.log('🔄 检测到重启状态文件，执行重启...');
      } else {
        console.log('🔄 子进程正常退出，准备重启...');
      }
      this.performRestart().catch((err) => {
        console.error('❌ 重启失败:', err);
        this.handleStartupFailure(err);
      });
      return;
    }

    console.log('❌ 子进程异常退出');
    this.handleStartupFailure(new Error(`进程异常退出，code: ${code}`));
  }

  private async handleStartupFailure(error: Error): Promise<void> {
    if (this.restartRetries < MAX_RESTART_RETRIES) {
      this.restartRetries++;
      console.log(`🔄 启动失败，进行第 ${this.restartRetries} 次重试...`);
      await this.forkChild();
      return;
    }

    if (!this.readState()) {
      console.error('❌ 首次启动失败，无可用回滚版本，退出');
      console.error(`   错误: ${error.message}`);
      console.error('   请检查代码后手动重启');
      process.exit(1);
      return;
    }

    console.log('❌ 重启后启动失败，执行回滚...');
    await this.performRollback(error);
  }

  /**
   * 执行回滚：stash 新代码 → 工作区恢复到上次 commit → 用旧代码启动
   */
  private async performRollback(error: Error): Promise<void> {
    console.log('📦 开始回滚流程...');

    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
      let stashCreated = false;

      if (status) {
        console.log('📦 git stash push -u 暂存问题代码（含新增文件）...');
        execFileSync('git', ['stash', 'push', '-u', '-m', 'launcher-auto-stash'], { stdio: 'inherit' });
        console.log('✅ 问题代码已暂存到 stash');
        stashCreated = true;
      } else {
        console.log('ℹ️ 工作区干净，无需暂存');
      }

      this.updateState({
        status: 'rollback',
        error: error.message,
        stashCreated,
      });

      console.log('🔄 使用上次验证通过的代码重新启动...');
      this.restartRetries = 0;
      await this.forkChild();
    } catch (rollbackError) {
      console.error('❌ 回滚流程失败:', rollbackError);
      this.updateState({
        status: 'rollback',
        error: `回滚失败: ${rollbackError instanceof Error ? rollbackError.message : 'Unknown'}`,
      });
    }
  }

  /**
   * 恢复 stash：回滚后启动成功，把问题代码放回工作区继续修改
   */
  private restoreStash(): void {
    console.log('📦 恢复 stash 到工作区...');

    try {
      const stashList = execSync('git stash list', { encoding: 'utf-8' });
      const lines = stashList.trim().split('\n');

      const targetLine = lines.find((line) => line.includes('launcher-auto-stash'));
      if (!targetLine) {
        console.log('ℹ️ 没有找到 launcher 的 stash，跳过');
        return;
      }

      const stashRef = targetLine.split(':')[0] as string;
      console.log(`📦 git stash pop ${stashRef}...`);

      try {
        execFileSync('git', ['stash', 'pop', stashRef], { stdio: 'inherit' });
        console.log('✅ 问题代码已恢复到工作区，可以继续修改');
      } catch {
        console.warn('⚠️ stash pop 冲突，请手动处理: git stash pop');
      }
    } catch (e) {
      console.error('❌ 恢复 stash 失败:', e);
    }
  }

  // ==================== 工具方法 ====================

  private notifyChildOfState(): void {
    if (!this.child) return;
    const state = this.readState();
    if (!state) return;

    this.child.send({ type: 'state', state });
  }

  private killChild(): Promise<void> {
    if (!this.child) return Promise.resolve();

    return new Promise((resolve) => {
      const child = this.child!;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        this.child = null;
        resolve();
      };

      child.once('exit', cleanup);
      child.kill('SIGTERM');

      const forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          console.log('⚠️ 子进程未响应 SIGTERM，强制终止');
          child.kill('SIGKILL');
        }
        setTimeout(cleanup, 1000);
      }, GRACEFUL_SHUTDOWN_TIMEOUT);
    });
  }

  /**
   * 启动前检查飞书 User Token 是否可用。
   * token 不存在或全部过期（access + refresh 均失效）→ 直接报错退出。
   */
  private checkFeishuToken(): void {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      console.error('❌ FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置，跳过 token 检查');
      return;
    }

    const client = new DeviceAuthClient({ appId, appSecret, platform: 'feishu' });
    const status = client.getTokenStatus();

    if (!status.hasToken) {
      console.error('❌ 飞书 User Token 不存在，请先执行 pnpm auth 完成授权');
      process.exit(1);
    }

    if (!status.accessTokenValid && !status.refreshTokenValid) {
      console.error('❌ 飞书 User Token 已全部过期（access + refresh），请执行 pnpm auth 重新授权');
      process.exit(1);
    }

    if (status.accessTokenValid) {
      console.log('✅ 飞书 User Token 有效');
    } else {
      console.log('⚠️ 飞书 access_token 已过期，refresh_token 有效，服务启动后将自动刷新');
    }
  }

  private setupSignalHandlers(): void {
    process.on('SIGINT', () => {
      console.log('\n🛑 收到 SIGINT，正在关闭...');
      this.shutdown();
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 收到 SIGTERM，正在关闭...');
      this.shutdown();
    });

    process.on('uncaughtException', (err) => {
      console.error('❌ 未捕获的异常:', err);
      this.shutdown(1);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('❌ 未处理的 Promise 拒绝:', reason);
    });
  }

  private async shutdown(exitCode = 0): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.child) {
      await this.killChild();
    }

    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
    }

    console.log('✅ Launcher 已关闭');
    process.exit(exitCode);
  }
}

// 启动
const launcher = new Launcher();
launcher.start().catch((err) => {
  console.error('❌ Launcher 启动失败:', err);
  process.exit(1);
});