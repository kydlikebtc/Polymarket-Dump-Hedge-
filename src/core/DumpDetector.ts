/**
 * 暴跌检测器
 * 分析价格变动，识别暴跌信号
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';
import type { CircularBuffer } from '../utils/CircularBuffer.js';
import type { PriceSnapshot, DumpSignal, Side, BotConfig } from '../types/index.js';

export class DumpDetector {
  private config: BotConfig;
  private windowSeconds: number = 3; // 检测窗口: 3秒
  private roundStartTime: number = 0;
  private lockedSide: Side | null = null; // 已触发的方向

  constructor(config: BotConfig) {
    this.config = config;

    logger.info('DumpDetector initialized', {
      movePct: `${config.movePct * 100}%`,
      windowMin: config.windowMin,
      detectionWindow: `${this.windowSeconds}s`,
    });
  }

  /**
   * 设置轮次开始时间
   */
  setRoundStartTime(timestamp: number): void {
    this.roundStartTime = timestamp;
    this.lockedSide = null; // 新轮次重置锁定
    logger.debug('Round start time set', { timestamp, roundStartTime: this.roundStartTime });
  }

  /**
   * 锁定方向 (Leg 1 触发后)
   */
  lockSide(side: Side): void {
    this.lockedSide = side;
    logger.info(`Side locked: ${side} - will not trigger again`, { side });
  }

  /**
   * 解锁方向
   */
  unlock(): void {
    this.lockedSide = null;
    logger.info('Detector unlocked');
  }

  /**
   * 检测暴跌信号
   */
  detect(
    priceBuffer: CircularBuffer<PriceSnapshot>,
    roundSlug: string
  ): DumpSignal | null {
    const now = Date.now();

    // 检查是否在监控窗口内
    if (!this.isWithinWindow(now)) {
      return null;
    }

    // 获取检测窗口内的价格数据
    const windowPrices = priceBuffer.getRecent(this.windowSeconds * 1000);

    if (windowPrices.length < 2) {
      logger.debug('Not enough price data for detection', { count: windowPrices.length });
      return null;
    }

    // 获取窗口内的第一个和最后一个价格
    const first = windowPrices[0];
    const last = windowPrices[windowPrices.length - 1];

    // 检测 UP 暴跌 (只有在未锁定该方向时)
    if (this.lockedSide !== 'UP' && first.upBestAsk > 0) {
      const upDrop = (first.upBestAsk - last.upBestAsk) / first.upBestAsk;

      if (upDrop >= this.config.movePct) {
        const signal: DumpSignal = {
          side: 'UP',
          dropPct: upDrop,
          price: last.upBestAsk,
          previousPrice: first.upBestAsk,
          timestamp: now,
          roundSlug,
        };

        logger.info('UP dump detected!', {
          dropPct: `${(upDrop * 100).toFixed(2)}%`,
          from: first.upBestAsk.toFixed(4),
          to: last.upBestAsk.toFixed(4),
        });

        eventBus.emitEvent('price:dump_detected', signal);
        return signal;
      }
    }

    // 检测 DOWN 暴跌 (只有在未锁定该方向时)
    if (this.lockedSide !== 'DOWN' && first.downBestAsk > 0) {
      const downDrop = (first.downBestAsk - last.downBestAsk) / first.downBestAsk;

      if (downDrop >= this.config.movePct) {
        const signal: DumpSignal = {
          side: 'DOWN',
          dropPct: downDrop,
          price: last.downBestAsk,
          previousPrice: first.downBestAsk,
          timestamp: now,
          roundSlug,
        };

        logger.info('DOWN dump detected!', {
          dropPct: `${(downDrop * 100).toFixed(2)}%`,
          from: first.downBestAsk.toFixed(4),
          to: last.downBestAsk.toFixed(4),
        });

        eventBus.emitEvent('price:dump_detected', signal);
        return signal;
      }
    }

    return null;
  }

  /**
   * 检查是否在监控窗口内
   */
  private isWithinWindow(currentTime: number): boolean {
    if (this.roundStartTime === 0) {
      return false;
    }

    const elapsedMs = currentTime - this.roundStartTime;
    const windowMs = this.config.windowMin * 60 * 1000;

    if (elapsedMs > windowMs) {
      logger.debug('Outside monitoring window', {
        elapsedMin: (elapsedMs / 60000).toFixed(1),
        windowMin: this.config.windowMin,
      });
      return false;
    }

    return true;
  }

  /**
   * 获取当前配置
   */
  getConfig(): { movePct: number; windowMin: number } {
    return {
      movePct: this.config.movePct,
      windowMin: this.config.windowMin,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(movePct?: number, windowMin?: number): void {
    if (movePct !== undefined) {
      if (movePct < 0.01 || movePct > 0.30) {
        throw new Error('movePct must be between 0.01 and 0.30');
      }
      this.config.movePct = movePct;
    }

    if (windowMin !== undefined) {
      if (windowMin < 1 || windowMin > 15) {
        throw new Error('windowMin must be between 1 and 15');
      }
      this.config.windowMin = windowMin;
    }

    logger.info('DumpDetector config updated', {
      movePct: `${this.config.movePct * 100}%`,
      windowMin: this.config.windowMin,
    });
  }

  /**
   * 检查是否有锁定的方向
   */
  isLocked(): boolean {
    return this.lockedSide !== null;
  }

  /**
   * 获取锁定的方向
   */
  getLockedSide(): Side | null {
    return this.lockedSide;
  }

  /**
   * 计算当前价格变动 (用于 UI 显示)
   */
  calculateCurrentDrop(priceBuffer: CircularBuffer<PriceSnapshot>): {
    up: number;
    down: number;
  } {
    const windowPrices = priceBuffer.getRecent(this.windowSeconds * 1000);

    if (windowPrices.length < 2) {
      return { up: 0, down: 0 };
    }

    const first = windowPrices[0];
    const last = windowPrices[windowPrices.length - 1];

    return {
      up: first.upBestAsk > 0
        ? (first.upBestAsk - last.upBestAsk) / first.upBestAsk
        : 0,
      down: first.downBestAsk > 0
        ? (first.downBestAsk - last.downBestAsk) / first.downBestAsk
        : 0,
    };
  }

  /**
   * 获取监控窗口剩余时间 (秒)
   */
  getRemainingWindowTime(): number {
    if (this.roundStartTime === 0) {
      return 0;
    }

    const elapsedMs = Date.now() - this.roundStartTime;
    const windowMs = this.config.windowMin * 60 * 1000;
    const remainingMs = Math.max(0, windowMs - elapsedMs);

    return Math.floor(remainingMs / 1000);
  }
}

export default DumpDetector;
