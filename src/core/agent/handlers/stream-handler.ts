import type { StreamEvent, EventHandlers } from '../types/agent'

export class StreamHandler {
  private eventHandlers: EventHandlers

  constructor(eventHandlers: EventHandlers = {}) {
    this.eventHandlers = eventHandlers
  }

  /**
   * 处理流式事件
   */
  async handleEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case 'content_start':
        await this.eventHandlers.onContentStart?.()
        break

      case 'content_delta':
        await this.eventHandlers.onContentDelta?.(event.delta)
        break

      case 'content_stop':
        await this.eventHandlers.onContentStop?.()
        break

      case 'tool_use_start':
        this.eventHandlers.onToolUseStart?.(event.toolName)
        break

      case 'tool_use_stop':
        await this.eventHandlers.onToolUseStop?.(event.toolName, event.result)
        break

      case 'error':
        await this.eventHandlers.onError?.(event.error)
        break

      default:
        console.warn('未知的流式事件类型:', event)
    }
  }

  /**
   * 设置事件处理器
   */
  setEventHandlers(eventHandlers: EventHandlers): void {
    this.eventHandlers = { ...this.eventHandlers, ...eventHandlers }
  }

  /**
   * 获取当前事件处理器
   */
  getEventHandlers(): EventHandlers {
    return { ...this.eventHandlers }
  }

  /**
   * 创建WebSocket流处理器
   */
  createWebSocketHandler(ws: WebSocket): EventHandlers {
    return {
      onContentStart: async () => {
        ws.send(JSON.stringify({ type: 'content_start' }))
      },
      onContentDelta: async (delta: string) => {
        ws.send(JSON.stringify({ type: 'content_delta', delta }))
      },
      onContentStop: async () => {
        ws.send(JSON.stringify({ type: 'content_stop' }))
      },
      onToolUseStart: async (toolName: string) => {
        ws.send(JSON.stringify({ type: 'tool_use_start', toolName }))
      },
      onToolUseStop: async (toolName: string, result: any) => {
        ws.send(JSON.stringify({ type: 'tool_use_stop', toolName, result }))
      },
      onError: async (error: string) => {
        ws.send(JSON.stringify({ type: 'error', error }))
      },
    }
  }

  /**
   * 创建HTTP流处理器
   */
  createHTTPStreamHandler(write: (chunk: string) => void): EventHandlers {
    return {
      onContentStart: async () => {
        write('data: ' + JSON.stringify({ type: 'content_start' }) + '\n\n')
      },
      onContentDelta: async (delta: string) => {
        write('data: ' + JSON.stringify({ type: 'content_delta', delta }) + '\n\n')
      },
      onContentStop: async () => {
        write('data: ' + JSON.stringify({ type: 'content_stop' }) + '\n\n')
      },
      onToolUseStart: async (toolName: string) => {
        write('data: ' + JSON.stringify({ type: 'tool_use_start', toolName }) + '\n\n')
      },
      onToolUseStop: async (toolName: string, result: any) => {
        write('data: ' + JSON.stringify({ type: 'tool_use_stop', toolName, result }) + '\n\n')
      },
      onError: async (error: string) => {
        write('data: ' + JSON.stringify({ type: 'error', error }) + '\n\n')
      },
    }
  }
}