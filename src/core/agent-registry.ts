/**
 * AgentEngine 全局注册表
 *
 * 解决循环依赖的核心模块。
 * 使用 `import type` 引用 AgentEngine，编译后完全擦除，零运行时依赖。
 *
 * 用法：
 *   - agent/index.ts 构造函数末尾调用 registerAgentEngine(this)
 *   - 其他模块通过 getAgentEngine() 获取实例
 */

import type { AgentEngine } from './agent/index.js'

let _engine: AgentEngine | null = null

/**
 * 注册 AgentEngine 实例（仅由 AgentEngine 构造函数调用一次）
 */
export function registerAgentEngine(engine: AgentEngine): void {
  _engine = engine
}

/**
 * 获取已注册的 AgentEngine 实例
 */
export function getAgentEngine(): AgentEngine {
  if (!_engine) {
    throw new Error('AgentEngine has not been registered yet. Ensure agent/index.ts is imported first.')
  }
  return _engine
}
