/**
 * 事件总线模块
 * 基于 EventEmitter3 的类型安全事件系统
 */

import EventEmitter from 'eventemitter3';
import type { BotEvents } from '../types/index.js';
import { logger } from './logger.js';

type EventCallback<T> = T extends void ? () => void : (data: T) => void;

/**
 * 类型安全的事件总线
 */
class TypedEventBus extends EventEmitter {
  private debugMode: boolean = false;

  constructor() {
    super();
    this.debugMode = process.env.DEBUG_EVENTS === 'true';
  }

  /**
   * 发射事件
   */
  emitEvent<K extends keyof BotEvents>(
    event: K,
    ...args: BotEvents[K] extends void ? [] : [BotEvents[K]]
  ): boolean {
    if (this.debugMode) {
      logger.debug(`Event emitted: ${String(event)}`, {
        data: args[0],
        listenerCount: this.listenerCount(event),
      });
    }
    return this.emit(event, ...args);
  }

  /**
   * 监听事件
   */
  onEvent<K extends keyof BotEvents>(
    event: K,
    callback: EventCallback<BotEvents[K]>
  ): this {
    // @ts-expect-error - EventEmitter3 类型限制
    return this.on(event, callback);
  }

  /**
   * 一次性监听事件
   */
  onceEvent<K extends keyof BotEvents>(
    event: K,
    callback: EventCallback<BotEvents[K]>
  ): this {
    // @ts-expect-error - EventEmitter3 类型限制
    return this.once(event, callback);
  }

  /**
   * 移除事件监听
   */
  offEvent<K extends keyof BotEvents>(
    event: K,
    callback?: EventCallback<BotEvents[K]>
  ): this {
    // @ts-expect-error - EventEmitter3 类型限制
    return this.off(event, callback);
  }

  /**
   * 等待事件
   */
  waitForEvent<K extends keyof BotEvents>(
    event: K,
    timeout?: number
  ): Promise<BotEvents[K]> {
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;

      const handler = (data: BotEvents[K]) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(data);
      };

      this.onceEvent(event, handler as EventCallback<BotEvents[K]>);

      if (timeout) {
        timeoutId = setTimeout(() => {
          this.offEvent(event, handler as EventCallback<BotEvents[K]>);
          reject(new Error(`Timeout waiting for event: ${String(event)}`));
        }, timeout);
      }
    });
  }

  /**
   * 启用调试模式
   */
  enableDebug(): void {
    this.debugMode = true;
    logger.info('Event bus debug mode enabled');
  }

  /**
   * 禁用调试模式
   */
  disableDebug(): void {
    this.debugMode = false;
  }

  /**
   * 获取所有事件的监听器数量
   */
  getListenerStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    const eventNames = this.eventNames();
    for (const event of eventNames) {
      stats[String(event)] = this.listenerCount(event);
    }
    return stats;
  }
}

// 单例事件总线
export const eventBus = new TypedEventBus();

// 便捷方法
export const emit = eventBus.emitEvent.bind(eventBus);
export const on = eventBus.onEvent.bind(eventBus);
export const once = eventBus.onceEvent.bind(eventBus);
export const off = eventBus.offEvent.bind(eventBus);
export const waitFor = eventBus.waitForEvent.bind(eventBus);

export default eventBus;
