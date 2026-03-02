import type { AgentResponse, EventHandlers } from '../types/agent'

export class LlmEngine {
  private config: {
    baseUrl: string
    apiKey: string
    model: string
  }

  constructor() {
    const config = this.getLLMConfig()
    this.config = config
  }

  /**
   * 获取LLM配置
   */
  private getLLMConfig() {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM配置缺失')
    }
    return {
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
    }
  }

  /**
   * 调用模型单轮对话
   */
  public async executeOnceLLMQuery(
    systemPrompt: string,
    userPrompt: string,
    {
      thinking = false, // 深度思考
      json_format = false, // json 格式输出
    } = {}
  ): Promise<string> {
    const startTime = Date.now()
    try {
      const config = this.config
      const response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...(thinking && { thinking: { type: 'enabled' } }),
          ...(json_format && { response_format: { type: 'json_object' } }),
        }),
      })
      if (!response.ok) {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`)
      }

      const data: any = await response.json()

      // 检查API响应结构
      if (data?.choices?.[0]?.message) {
        return data.choices[0].message.content
      } else {
        throw new Error(`API响应格式异常, data: ${JSON.stringify(data)}`)
      }
    } catch (error) {
      throw new Error(`API响应格式异常: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      console.log(`LLM API调用耗时: ${(Date.now() - startTime) / 1000}s`)
    }
  }
}
