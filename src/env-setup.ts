import dotenv from 'dotenv'

dotenv.config()

// 对claude agent sdk 会有影响，清理环境变量
delete process.env.http_proxy
delete process.env.https_proxy
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY