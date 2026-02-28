import type { StreamEvent, EventHandlers } from '../types/agent'

export class StreamHandler {
  private eventHandlers: EventHandlers

  constructor(eventHandlers: EventHandlers = {}) {
    this.eventHandlers = eventHandlers
  }

  /**
   * 处理流式事件
   */
  handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'content_start':
        this.eventHandlers.onContentStart?.()
        break

      case 'content_delta':
        this.eventHandlers.onContentDelta?.(event.delta)
        break

      case 'content_stop':
        this.eventHandlers.onContentStop?.()
        break

      case 'tool_use_start':
        this.eventHandlers.onToolUseStart?.(event.toolName)
        break

      case 'tool_use_stop':
        this.eventHandlers.onToolUseStop?.(event.toolName, event.result)
        break

      case 'error':
        this.eventHandlers.onError?.(event.error)
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
      onContentStart: () => {
        ws.send(JSON.stringify({ type: 'content_start' }))
      },
      onContentDelta: (delta: string) => {
        ws.send(JSON.stringify({ type: 'content_delta', delta }))
      },
      onContentStop: () => {
        ws.send(JSON.stringify({ type: 'content_stop' }))
      },
      onToolUseStart: (toolName: string) => {
        ws.send(JSON.stringify({ type: 'tool_use_start', toolName }))
      },
      onToolUseStop: (toolName: string, result: any) => {
        ws.send(JSON.stringify({ type: 'tool_use_stop', toolName, result }))
      },
      onError: (error: string) => {
        ws.send(JSON.stringify({ type: 'error', error }))
      },
    }
  }

  /**
   * 创建HTTP流处理器
   */
  createHTTPStreamHandler(write: (chunk: string) => void): EventHandlers {
    return {
      onContentStart: () => {
        write('data: ' + JSON.stringify({ type: 'content_start' }) + '\n\n')
      },
      onContentDelta: (delta: string) => {
        write('data: ' + JSON.stringify({ type: 'content_delta', delta }) + '\n\n')
      },
      onContentStop: () => {
        write('data: ' + JSON.stringify({ type: 'content_stop' }) + '\n\n')
      },
      onToolUseStart: (toolName: string) => {
        write('data: ' + JSON.stringify({ type: 'tool_use_start', toolName }) + '\n\n')
      },
      onToolUseStop: (toolName: string, result: any) => {
        write('data: ' + JSON.stringify({ type: 'tool_use_stop', toolName, result }) + '\n\n')
      },
      onError: (error: string) => {
        write('data: ' + JSON.stringify({ type: 'error', error }) + '\n\n')
      },
    }
  }
}