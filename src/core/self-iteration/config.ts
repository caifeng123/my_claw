// src/core/self-iteration/config.ts
// 自迭代系统配置常量 (V3)

import type { SelfIterationConfig } from './types.js'
import { join } from 'node:path'

export const DEFAULT_CONFIG: SelfIterationConfig = {
  enabled: true,
  safety: {
    maxSkillMdDiffRatio: 0.5,
    maxOptimizationsPerDay: 3,
  },
}

/** Skill 定义 + iteration 产物统一根目录 */
export const SKILLS_DIR = join(process.cwd(), '.claude', 'skills')
