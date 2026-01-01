/**
 * 轮次管理器
 * 自动检测和管理 BTC 15分钟轮次
 * v0.2.0: 集成 MarketDiscoveryService 实现自动轮换
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';
import { MarketDiscoveryService, type Btc15mMarket } from '../api/MarketDiscoveryService.js';
import type { PriceSnapshot, MarketInfo, Btc15mMarketInfo } from '../types/index.js';

// BTC 15分钟轮次配置
const ROUND_WARNING_THRESHOLD = 60; // 剩余60秒时发出警告
const PRELOAD_THRESHOLD = 30; // 剩余30秒时预加载下一市场

/**
 * 轮次信息
 */
interface RoundInfo {
  slug: string;
  startTime: number;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
}

export class RoundManager {
  private currentRound: RoundInfo | null = null;
  private roundEndWarningEmitted: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  // v0.2.0: 市场发现服务
  private discoveryService: MarketDiscoveryService | null = null;
  private autoDiscoverEnabled: boolean = false;
  private isTransitioning: boolean = false;
  private onMarketSwitchCallback: ((market: Btc15mMarket) => Promise<void>) | null = null;

  constructor() {
    logger.info('RoundManager initialized', {
      roundDuration: '15 minutes',
      warningThreshold: `${ROUND_WARNING_THRESHOLD}s`,
      preloadThreshold: `${PRELOAD_THRESHOLD}s`,
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

  // ========== v0.2.0: 自动市场发现和轮换 ==========

  /**
   * 启用自动市场发现
   * @param callback 市场切换时的回调函数
   */
  enableAutoDiscover(callback: (market: Btc15mMarket) => Promise<void>): void {
    if (this.autoDiscoverEnabled) {
      logger.warn('Auto-discover already enabled');
      return;
    }

    this.discoveryService = new MarketDiscoveryService();
    this.onMarketSwitchCallback = callback;
    this.autoDiscoverEnabled = true;

    // 监听市场发现事件
    eventBus.onEvent('market:discovered', (market: Btc15mMarketInfo) => {
      logger.debug('Market discovered event received', { slug: market.slug });
    });

    // 启动发现服务
    this.discoveryService.start();

    logger.info('Auto-discover enabled', {
      discoveryInterval: '10s',
      preloadThreshold: `${PRELOAD_THRESHOLD}s`,
    });
  }

  /**
   * 禁用自动市场发现
   */
  disableAutoDiscover(): void {
    if (!this.autoDiscoverEnabled) {
      return;
    }

    if (this.discoveryService) {
      this.discoveryService.stop();
      this.discoveryService = null;
    }

    this.onMarketSwitchCallback = null;
    this.autoDiscoverEnabled = false;

    logger.info('Auto-discover disabled');
  }

  /**
   * 从 BTC 15m 市场设置轮次
   */
  setFromBtc15mMarket(market: Btc15mMarket): void {
    const oldSlug = this.currentRound?.slug;

    this.currentRound = {
      slug: market.slug,
      startTime: market.startTime,
      endTime: market.endTime,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
    };

    this.roundEndWarningEmitted = false;

    logger.info('Round set from BTC 15m market', {
      slug: this.currentRound.slug,
      upTokenId: this.currentRound.upTokenId.substring(0, 20) + '...',
      downTokenId: this.currentRound.downTokenId.substring(0, 20) + '...',
      startTime: new Date(this.currentRound.startTime).toISOString(),
      endTime: new Date(this.currentRound.endTime).toISOString(),
      secondsRemaining: this.getSecondsRemaining(),
    });

    // 发送市场切换事件
    if (oldSlug && oldSlug !== market.slug) {
      eventBus.emitEvent('market:switching', {
        from: oldSlug,
        to: market.slug,
      });
    }

    eventBus.emitEvent('round:new', {
      roundSlug: this.currentRound.slug,
      startTime: this.currentRound.startTime,
    });

    eventBus.emitEvent('market:switched', market as Btc15mMarketInfo);
  }

  /**
   * 自动切换到下一个市场
   */
  async autoTransitionToNextMarket(): Promise<boolean> {
    if (!this.autoDiscoverEnabled || !this.discoveryService) {
      logger.warn('Auto-discover not enabled, cannot auto-transition');
      return false;
    }

    if (this.isTransitioning) {
      logger.debug('Already transitioning, skipping');
      return false;
    }

    this.isTransitioning = true;

    try {
      logger.info('Starting auto-transition to next market');

      // 先尝试获取已发现的下一个市场
      let nextMarket = this.discoveryService.getNextMarket();

      // 如果没有，刷新并等待
      if (!nextMarket) {
        logger.info('No next market cached, waiting for discovery...');
        nextMarket = await this.discoveryService.waitForNextMarket(30000);
      }

      if (!nextMarket) {
        logger.warn('No next market available after waiting');
        eventBus.emitEvent('market:wait_for_next', { retryCount: 1 });
        return false;
      }

      // 等待新市场激活
      const now = Date.now();
      if (nextMarket.startTime > now) {
        const waitTime = nextMarket.startTime - now + 1000; // 多等1秒确保激活
        logger.info(`Waiting ${waitTime}ms for market to activate`, {
          marketSlug: nextMarket.slug,
          startTime: new Date(nextMarket.startTime).toISOString(),
        });
        await this.sleep(Math.min(waitTime, 15000));
      }

      // 设置新轮次
      this.setFromBtc15mMarket(nextMarket);

      // 执行回调
      if (this.onMarketSwitchCallback) {
        await this.onMarketSwitchCallback(nextMarket);
      }

      logger.info('Auto-transition completed', {
        newMarketSlug: nextMarket.slug,
        secondsRemaining: this.getSecondsRemaining(),
      });

      return true;

    } catch (error) {
      logger.error('Auto-transition failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.isTransitioning = false;
    }
  }

  /**
   * 获取发现服务实例
   */
  getDiscoveryService(): MarketDiscoveryService | null {
    return this.discoveryService;
  }

  /**
   * 检查是否启用了自动发现
   */
  isAutoDiscoverEnabled(): boolean {
    return this.autoDiscoverEnabled;
  }

  /**
   * 获取当前发现的市场
   */
  getCurrentDiscoveredMarket(): Btc15mMarket | null {
    return this.discoveryService?.getCurrentMarket() || null;
  }

  /**
   * 获取下一个发现的市场
   */
  getNextDiscoveredMarket(): Btc15mMarket | null {
    return this.discoveryService?.getNextMarket() || null;
  }

  /**
   * 强制刷新市场发现
   */
  async refreshMarketDiscovery(): Promise<Btc15mMarket | null> {
    if (!this.discoveryService) {
      logger.warn('Discovery service not initialized');
      return null;
    }

    return this.discoveryService.refresh();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RoundManager;
