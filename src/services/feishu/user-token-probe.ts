/**
 * UserTokenProbe — 定期调用 lark-cli auth status --verify 触发 token 自动续期
 *
 * 设计原则：
 *   - 不管理任何 token，全部交给 lark-cli
 *   - 唯一职责：定时「戳」一下 lark-cli，让它内部的 GetValidAccessToken() 自动刷新
 *   - 刷新失败时通过 bot 身份（永不过期）给用户发飞书消息告警
 *
 * lark-cli auth status --verify 内部行为：
 *   1. 从 OS keychain 读取 StoredUAToken
 *   2. 调用 GetValidAccessToken()：
 *      - access_token 有效 → 直接用
 *      - access_token 过期但 refresh_token 有效 → 自动刷新并写回 keychain
 *      - refresh_token 也过期 → 报错
 *   3. 用 access_token 调 /authen/v1/user_info 验证
 *   4. 输出文本，含 "Verified: ✓" 或错误信息
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface UserTokenProbeOptions {
  /** 正常探活间隔，默认 24h */
  intervalMs?: number;
  /** 失败后缩短的重试间隔，默认 30min */
  retryIntervalMs?: number;
  /** 连续失败几次后告警，默认 3 */
  maxConsecutiveFails?: number;
  /** 告警回调（发飞书消息等），不传则只写日志 */
  onAlert?: (message: string) => Promise<void>;
}

export interface ProbeResult {
  success: boolean;
  verified?: boolean;
  userName?: string;
  error?: string;
  rawOutput?: string;
  consecutiveFails: number;
}

const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000;        // 24h
const DEFAULT_RETRY_INTERVAL = 30 * 60 * 1000;       // 30min
const DEFAULT_MAX_CONSECUTIVE_FAILS = 3;
const PROBE_TIMEOUT = 30_000;                          // 30s

export class UserTokenProbe {
  private opts: Required<Omit<UserTokenProbeOptions, 'onAlert'>> & { onAlert?: (msg: string) => Promise<void> };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFails = 0;
  private lastProbeAt: Date | null = null;
  private alerted = false;

  constructor(options: UserTokenProbeOptions = {}) {
    this.opts = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL,
      retryIntervalMs: options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL,
      maxConsecutiveFails: options.maxConsecutiveFails ?? DEFAULT_MAX_CONSECUTIVE_FAILS,
      onAlert: options.onAlert,
    };
    this.start();
  }

  /**
   * 启动探活：立即执行一次，然后按间隔定时执行
   */
  start(): void {
    console.log(`🔑 [UserTokenProbe] 启动，正常间隔=${this.opts.intervalMs / 1000 / 60}min，重试间隔=${this.opts.retryIntervalMs / 1000 / 60}min`);
    this.runProbe();
  }

  /**
   * 停止探活
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('🔑 [UserTokenProbe] 已停止');
  }

  /**
   * 手动执行一次探活
   */
  async probeOnce(): Promise<ProbeResult> {
    return this.executeProbe();
  }

  /**
   * 获取当前状态
   */
  getStatus(): { consecutiveFails: number; lastProbeAt: Date | null; alerted: boolean } {
    return {
      consecutiveFails: this.consecutiveFails,
      lastProbeAt: this.lastProbeAt,
      alerted: this.alerted,
    };
  }

  // ─── 内部实现 ───

  private runProbe(): void {
    this.executeProbe()
      .then(result => this.scheduleNext(result.success))
      .catch(() => this.scheduleNext(false));
  }

  private scheduleNext(lastSuccess: boolean): void {
    if (this.timer) clearTimeout(this.timer);

    const interval = this.opts.intervalMs

    this.timer = setTimeout(() => this.runProbe(), interval);

    // 不阻止 Node.js 进程退出
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    console.log(
      `🔑 [UserTokenProbe] 下次探活: ${Math.round(interval / 1000 / 60)}min 后 (${lastSuccess ? '正常' : '重试'})`,
    );
  }

  private async executeProbe(): Promise<ProbeResult> {
    console.log('🔑 [UserTokenProbe] 执行探活...');

    try {
      const { stdout, stderr } = await execAsync(
        'lark-cli auth status --verify',
        { timeout: PROBE_TIMEOUT },
      );

      const output = (stdout + '\n' + stderr).trim();
      const userName = this.parseUserName(output);

      // exit code 0 = lark-cli 认为 token 有效且验证通过
      this.consecutiveFails = 0;
      this.alerted = false;
      this.lastProbeAt = new Date();

      console.log(`🔑 [UserTokenProbe] ✅ token 有效 — user=${userName ?? '?'}`);

      return {
        success: true,
        verified: true,
        userName,
        rawOutput: output,
        consecutiveFails: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`🔑 [UserTokenProbe] ❌ 探活失败 #${++this.consecutiveFails} — ${message}`);
      return {
        success: false,
        error: message,
        consecutiveFails: this.consecutiveFails,
      };
    }
  }

  private parseUserName(output: string): string | undefined {
    const match = output.match(/(?:User|Name|用户|姓名)\s*[:：]\s*(.+)/i);
    return match?.[1]?.trim();
  }
}
