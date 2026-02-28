import { FeishuAgentBridgeConfig } from '../services/feishu/feishu-agent-bridge.js'

/**
 * 飞书配置
 */
export interface FeishuConfig {
  // 飞书应用ID
  appId: string
  // 飞书应用密钥
  appSecret: string
  // 是否启用飞书集成
  enabled: boolean
  // 桥接器配置
  bridge?: Partial<FeishuAgentBridgeConfig>
}

/**
 * 从环境变量获取飞书配置
 */
export function getFeishuConfig(): FeishuConfig {
  const appId = process.env.FEISHU_APP_ID || ''
  const appSecret = process.env.FEISHU_APP_SECRET || ''
  const enabled = process.env.FEISHU_ENABLED === 'true' && !!appId && !!appSecret

  return {
    appId,
    appSecret,
    enabled,
    bridge: {
      sessionPrefix: 'feishu_',
      enableStreaming: true,
      showTypingIndicator: true,
    }
  }
}

/**
 * 验证飞书配置是否有效
 */
export function validateFeishuConfig(config: FeishuConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (config.enabled) {
    if (!config.appId) {
      errors.push('FEISHU_APP_ID 未设置')
    }
    if (!config.appSecret) {
      errors.push('FEISHU_APP_SECRET 未设置')
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}