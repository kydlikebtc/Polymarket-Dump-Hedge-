/**
 * 轮次管理器
 * 自动检测和管理 BTC 15分钟轮次
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';
import type { PriceSnapshot, MarketInfo } from '../types/index.js';

// BTC 15分钟轮次配置
const ROUND_WARNING_THRESHOLD = 60; // 剩余60秒时发出警告

export class RoundManager {
  private currentRound: {
    slug: string;
    startTime: number;
    endTime: number;
    upTokenId: string;
    downTokenId: string;
  } | null = null;

  private roundEndWarningEmitted: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    logger.info('RoundManager initialized', {
      roundDuration: '15 minutes',
      warningThreshold: `${ROUND_WARNING_THRESHOLD}s`,
    });
  }

  /**
   * 从价格快照更新轮次信息
   */
  updateFromSnapshot(snapshot: PriceSnapshot): void {
    // 检查是否是新轮次
    if (this.currentRound?.slug !== snapshot.roundSlug) {
      this.handleNewRound(snapshot);
    }

    // 检查轮次是否即将结束
    if (snapshot.secondsRemaining <= ROUND_WARNING_THRESHOLD && !this.roundEndWarningEmitted) {
      this.emitRoundEndingWarning(snapshot.secondsRemaining);
    }

    // 检查轮次是否已结束
    if (snapshot.secondsRemaining <= 0) {
      this.handleRoundExpired();
    }
  }

  /**
   * 处理新轮次
   */
  private handleNewRound(snapshot: PriceSnapshot): void {
    // 如果有旧轮次，先触发过期事件
    if (this.currentRound) {
      this.handleRoundExpired();
    }

    // 设置新轮次
    this.currentRound = {
      slug: snapshot.roundSlug,
      startTime: Date.now(),
      endTime: Date.now() + snapshot.secondsRemaining * 1000,
      upTokenId: snapshot.upTokenId,
      downTokenId: snapshot.downTokenId,
    };

    this.roundEndWarningEmitted = false;

    logger.info('New round started', {
      slug: this.currentRound.slug,
      upTokenId: this.currentRound.upTokenId,
      downTokenId: this.currentRound.downTokenId,
      secondsRemaining: snapshot.secondsRemaining,
    });

    eventBus.emitEvent('round:new', {
      roundSlug: this.currentRound.slug,
      startTime: this.currentRound.startTime,
    });
  }

  /**
   * 发出轮次即将结束警告
   */
  private emitRoundEndingWarning(secondsRemaining: number): void {
    this.roundEndWarningEmitted = true;

    logger.warn('Round ending soon', {
      slug: this.currentRound?.slug,
      secondsRemaining,
    });

    if (this.currentRound) {
      eventBus.emitEvent('round:ending', {
        roundSlug: this.currentRound.slug,
        secondsRemaining,
      });
    }
  }

  /**
   * 处理轮次过期
   */
  private handleRoundExpired(): void {
    if (!this.currentRound) {
      return;
    }

    logger.info('Round expired', {
      slug: this.currentRound.slug,
    });

    eventBus.emitEvent('round:expired', {
      roundSlug: this.currentRound.slug,
    });

    // 清理当前轮次
    this.currentRound = null;
    this.roundEndWarningEmitted = false;
  }

  /**
   * 从市场信息设置轮次
   */
  setFromMarketInfo(marketInfo: MarketInfo): void {
    this.currentRound = {
      slug: marketInfo.roundSlug,
      startTime: marketInfo.startTime,
      endTime: marketInfo.endTime,
      upTokenId: marketInfo.upTokenId,
      downTokenId: marketInfo.downTokenId,
    };

    this.roundEndWarningEmitted = false;

    logger.info('Round set from market info', {
      slug: this.currentRound.slug,
      startTime: new Date(this.currentRound.startTime).toISOString(),
      endTime: new Date(this.currentRound.endTime).toISOString(),
    });

    eventBus.emitEvent('round:new', {
      roundSlug: this.currentRound.slug,
      startTime: this.currentRound.startTime,
    });
  }

  /**
   * 获取当前轮次信息
   */
  getCurrentRound(): {
    slug: string;
    startTime: number;
    endTime: number;
    upTokenId: string;
    downTokenId: string;
  } | null {
    return this.currentRound;
  }

  /**
   * 获取当前轮次 slug
   */
  getCurrentRoundSlug(): string | null {
    return this.currentRound?.slug || null;
  }

  /**
   * 获取轮次开始时间
   */
  getRoundStartTime(): number {
    return this.currentRound?.startTime || 0;
  }

  /**
   * 获取轮次剩余秒数
   */
  getSecondsRemaining(): number {
    if (!this.currentRound) {
      return 0;
    }

    const remaining = Math.floor((this.currentRound.endTime - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  /**
   * 检查轮次是否活跃
   */
  isRoundActive(): boolean {
    return this.currentRound !== null && this.getSecondsRemaining() > 0;
  }

  /**
   * 获取 UP Token ID
   */
  getUpTokenId(): string | null {
    return this.currentRound?.upTokenId || null;
  }

  /**
   * 获取 DOWN Token ID
   */
  getDownTokenId(): string | null {
    return this.currentRound?.downTokenId || null;
  }

  /**
   * 获取指定方向的 Token ID
   */
  getTokenId(side: 'UP' | 'DOWN'): string | null {
    if (!this.currentRound) {
      return null;
    }
    return side === 'UP' ? this.currentRound.upTokenId : this.currentRound.downTokenId;
  }

  /**
   * 启动定期检查
   */
  startPeriodicCheck(intervalMs: number = 1000): void {
    this.stopPeriodicCheck();

    this.checkInterval = setInterval(() => {
      if (!this.currentRound) {
        return;
      }

      const remaining = this.getSecondsRemaining();

      // 检查警告
      if (remaining <= ROUND_WARNING_THRESHOLD && !this.roundEndWarningEmitted) {
        this.emitRoundEndingWarning(remaining);
      }

      // 检查过期
      if (remaining <= 0) {
        this.handleRoundExpired();
      }
    }, intervalMs);

    logger.debug('Periodic round check started', { intervalMs });
  }

  /**
   * 停止定期检查
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * 手动触发轮次过期
   */
  forceExpire(): void {
    this.handleRoundExpired();
  }

  /**
   * 获取轮次状态描述
   */
  getStatusDescription(): string {
    if (!this.currentRound) {
      return 'No active round';
    }

    const remaining = this.getSecondsRemaining();
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    return `Round: ${this.currentRound.slug} | Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

export default RoundManager;
