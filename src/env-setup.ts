import dotenv from 'dotenv'

dotenv.config()

// 对claude agent sdk 会有影响，清理环境变量
process.env.no_proxy = [process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
process.env.NO_PROXY = process.env.no_proxy