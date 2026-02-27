import { z } from 'zod'

// 环境变量模式验证
const envSchema = z.object({
  // 飞书配置
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_VERIFICATION_TOKEN: z.string().min(1),
  FEISHU_ENCRYPT_KEY: z.string().optional(),

  // Claude API 配置
  ANTHROPIC_API_KEY: z.string().min(1),

  // 应用配置
  PORT: z.string().transform(Number).default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // 数据库配置
  DATABASE_PATH: z.string().default('./data/cf_claw.db'),

  // Memory 存储路径
  MEMORY_BASE_PATH: z.string().default('./data/memory')
})

export type EnvConfig = z.infer<typeof envSchema>

class Config {
  private config: EnvConfig

  constructor() {
    const result = envSchema.safeParse(process.env)

    if (!result.success) {
      console.error('❌ 环境变量配置错误:')
      result.error.errors.forEach((error) => {
        console.error(`  - ${error.path.join('.')}: ${error.message}`)
      })
      throw new Error('环境变量验证失败')
    }

    this.config = result.data
    console.log('✅ 环境变量配置验证通过')
  }

  get<T extends keyof EnvConfig>(key: T): EnvConfig[T] {
    return this.config[key]
  }

  getAll(): EnvConfig {
    return { ...this.config }
  }

  isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development'
  }

  isProduction(): boolean {
    return this.config.NODE_ENV === 'production'
  }
}

// 创建全局配置实例
export const config = new Config()

export default config