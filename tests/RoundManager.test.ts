/**
 * RoundManager 单元测试
 *
 * 测试轮次管理和 v0.2.0 自动市场轮换功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock MarketDiscoveryService
vi.mock('../src/api/MarketDiscoveryService.js', () => ({
  MarketDiscoveryService: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getCurrentMarket: vi.fn(),
    getNextMarket: vi.fn(),
    waitForNextMarket: vi.fn(),
    refresh: vi.fn(),
    discoverMarkets: vi.fn(),
  })),
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock eventBus
vi.mock('../src/utils/EventBus.js', () => ({
  eventBus: {
    emitEvent: vi.fn(),
    onEvent: vi.fn(),
    emit: vi.fn(),
  },
}));

import { RoundManager } from '../src/core/RoundManager.js';
import { MarketDiscoveryService, type Btc15mMarket } from '../src/api/MarketDiscoveryService.js';
import { eventBus } from '../src/utils/EventBus.js';
import type { PriceSnapshot, MarketInfo } from '../src/types/index.js';

describe('RoundManager', () => {
  let roundManager: RoundManager;

  // 创建模拟市场
  const createMockBtc15mMarket = (options: Partial<Btc15mMarket> = {}): Btc15mMarket => ({
    conditionId: options.conditionId || 'condition-123',
    slug: options.slug || 'btc-15min-test',
    question: options.question || 'Will BTC go Up or Down?',
    upTokenId: options.upTokenId || 'up-token-123',
    downTokenId: options.downTokenId || 'down-token-456',
    startTime: options.startTime || Date.now() - 5 * 60 * 1000,
    endTime: options.endTime || Date.now() + 10 * 60 * 1000,
    status: options.status || 'active',
    outcomes: options.outcomes || ['Up', 'Down'],
    outcomePrices: options.outcomePrices || ['0.5', '0.5'],
  });

  // 创建模拟价格快照
  const createMockSnapshot = (options: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
    timestamp: options.timestamp || Date.now(),
    roundSlug: options.roundSlug || 'btc-15min-test',
    secondsRemaining: options.secondsRemaining ?? 600,
    upTokenId: options.upTokenId || 'up-token-123',
    downTokenId: options.downTokenId || 'down-token-456',
    upBestAsk: options.upBestAsk ?? 0.45,
    upBestBid: options.upBestBid ?? 0.44,
    downBestAsk: options.downBestAsk ?? 0.55,
    downBestBid: options.downBestBid ?? 0.54,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    roundManager = new RoundManager();
  });

  afterEach(() => {
    roundManager.stopPeriodicCheck();
    roundManager.disableAutoDiscover();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('初始化', () => {
    it('应该正确初始化', () => {
      expect(roundManager).toBeDefined();
      expect(roundManager.getCurrentRound()).toBeNull();
      expect(roundManager.getCurrentRoundSlug()).toBeNull();
    });

    it('初始状态应该无活跃轮次', () => {
      expect(roundManager.isRoundActive()).toBe(false);
      expect(roundManager.getSecondsRemaining()).toBe(0);
    });

    it('自动发现应该默认禁用', () => {
      expect(roundManager.isAutoDiscoverEnabled()).toBe(false);
    });
  });

  describe('从快照更新', () => {
    it('updateFromSnapshot() 应该设置新轮次', () => {
      const snapshot = createMockSnapshot({ roundSlug: 'new-round' });

      roundManager.updateFromSnapshot(snapshot);

      expect(roundManager.getCurrentRoundSlug()).toBe('new-round');
      expect(roundManager.getUpTokenId()).toBe(snapshot.upTokenId);
      expect(roundManager.getDownTokenId()).toBe(snapshot.downTokenId);
    });

    it('应该触发 round:new 事件', () => {
      const snapshot = createMockSnapshot();

      roundManager.updateFromSnapshot(snapshot);

      expect(eventBus.emitEvent).toHaveBeenCalledWith('round:new', expect.objectContaining({
        roundSlug: snapshot.roundSlug,
      }));
    });

    it('新轮次应该替换旧轮次', () => {
      const snapshot1 = createMockSnapshot({ roundSlug: 'round-1' });
      const snapshot2 = createMockSnapshot({ roundSlug: 'round-2' });

      roundManager.updateFromSnapshot(snapshot1);
      roundManager.updateFromSnapshot(snapshot2);

      expect(roundManager.getCurrentRoundSlug()).toBe('round-2');
    });

    it('轮次即将结束时应该触发警告', () => {
      const snapshot = createMockSnapshot({ secondsRemaining: 50 }); // 小于60秒阈值

      roundManager.updateFromSnapshot(snapshot);

      expect(eventBus.emitEvent).toHaveBeenCalledWith('round:ending', expect.objectContaining({
        roundSlug: snapshot.roundSlug,
        secondsRemaining: 50,
      }));
    });

    it('轮次已结束应该触发过期事件', () => {
      // 先设置一个轮次
      const snapshot1 = createMockSnapshot({ secondsRemaining: 100 });
      roundManager.updateFromSnapshot(snapshot1);

      // 然后更新为已结束
      const snapshot2 = createMockSnapshot({ secondsRemaining: 0 });
      roundManager.updateFromSnapshot(snapshot2);

      expect(eventBus.emitEvent).toHaveBeenCalledWith('round:expired', expect.objectContaining({
        roundSlug: snapshot2.roundSlug,
      }));
    });
  });

  describe('从市场信息设置', () => {
    it('setFromMarketInfo() 应该正确设置轮次', () => {
      const marketInfo: MarketInfo = {
        roundSlug: 'test-market',
        upTokenId: 'up-123',
        downTokenId: 'down-456',
        startTime: Date.now(),
        endTime: Date.now() + 15 * 60 * 1000,
        status: 'active',
      };

      roundManager.setFromMarketInfo(marketInfo);

      expect(roundManager.getCurrentRoundSlug()).toBe('test-market');
      expect(roundManager.getUpTokenId()).toBe('up-123');
      expect(roundManager.getDownTokenId()).toBe('down-456');
    });
  });

  describe('轮次状态查询', () => {
    beforeEach(() => {
      const snapshot = createMockSnapshot({ secondsRemaining: 600 });
      roundManager.updateFromSnapshot(snapshot);
    });

    it('isRoundActive() 应该返回 true', () => {
      expect(roundManager.isRoundActive()).toBe(true);
    });

    it('getSecondsRemaining() 应该返回正确的剩余时间', () => {
      const remaining = roundManager.getSecondsRemaining();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(600);
    });

    it('getTokenId() 应该返回正确的 Token ID', () => {
      expect(roundManager.getTokenId('UP')).toBe('up-token-123');
      expect(roundManager.getTokenId('DOWN')).toBe('down-token-456');
    });

    it('getStatusDescription() 应该返回格式化描述', () => {
      const desc = roundManager.getStatusDescription();
      expect(desc).toContain('Round:');
      expect(desc).toContain('Time:');
    });
  });

  describe('定期检查', () => {
    it('startPeriodicCheck() 应该启动定时器', () => {
      const snapshot = createMockSnapshot({ secondsRemaining: 100 });
      roundManager.updateFromSnapshot(snapshot);

      roundManager.startPeriodicCheck(1000);

      // 清除警告标志以便测试
      (roundManager as unknown as { roundEndWarningEmitted: boolean }).roundEndWarningEmitted = false;

      // 推进时间
      vi.advanceTimersByTime(1000);

      // 应该有定期检查
    });

    it('stopPeriodicCheck() 应该停止定时器', () => {
      roundManager.startPeriodicCheck(1000);
      roundManager.stopPeriodicCheck();

      // 不应该有更多的检查
    });

    it('forceExpire() 应该强制过期', () => {
      const snapshot = createMockSnapshot({ secondsRemaining: 600 });
      roundManager.updateFromSnapshot(snapshot);

      roundManager.forceExpire();

      expect(roundManager.getCurrentRound()).toBeNull();
      expect(eventBus.emitEvent).toHaveBeenCalledWith('round:expired', expect.any(Object));
    });
  });

  // ========== v0.2.0: 自动市场发现测试 ==========

  describe('v0.2.0: 自动市场发现', () => {
    let mockDiscoveryService: {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      getCurrentMarket: ReturnType<typeof vi.fn>;
      getNextMarket: ReturnType<typeof vi.fn>;
      waitForNextMarket: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      // 获取 mock 实例
      mockDiscoveryService = {
        start: vi.fn(),
        stop: vi.fn(),
        getCurrentMarket: vi.fn(),
        getNextMarket: vi.fn(),
        waitForNextMarket: vi.fn(),
        refresh: vi.fn(),
      };

      (MarketDiscoveryService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockDiscoveryService);
    });

    describe('enableAutoDiscover()', () => {
      it('应该启用自动发现', async () => {
        const callback = vi.fn();

        roundManager.enableAutoDiscover(callback);

        expect(roundManager.isAutoDiscoverEnabled()).toBe(true);
        expect(mockDiscoveryService.start).toHaveBeenCalled();
      });

      it('重复启用应该被忽略', () => {
        const callback = vi.fn();

        roundManager.enableAutoDiscover(callback);
        roundManager.enableAutoDiscover(callback);

        expect(MarketDiscoveryService).toHaveBeenCalledTimes(1);
      });

      it('应该注册事件监听', () => {
        const callback = vi.fn();

        roundManager.enableAutoDiscover(callback);

        expect(eventBus.onEvent).toHaveBeenCalledWith('market:discovered', expect.any(Function));
      });
    });

    describe('disableAutoDiscover()', () => {
      it('应该禁用自动发现', () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        roundManager.disableAutoDiscover();

        expect(roundManager.isAutoDiscoverEnabled()).toBe(false);
        expect(mockDiscoveryService.stop).toHaveBeenCalled();
      });

      it('未启用时调用应该安全', () => {
        expect(() => roundManager.disableAutoDiscover()).not.toThrow();
      });
    });

    describe('setFromBtc15mMarket()', () => {
      it('应该从 BTC 15m 市场设置轮次', () => {
        const market = createMockBtc15mMarket();

        roundManager.setFromBtc15mMarket(market);

        expect(roundManager.getCurrentRoundSlug()).toBe(market.slug);
        expect(roundManager.getUpTokenId()).toBe(market.upTokenId);
        expect(roundManager.getDownTokenId()).toBe(market.downTokenId);
      });

      it('应该触发 round:new 事件', () => {
        const market = createMockBtc15mMarket();

        roundManager.setFromBtc15mMarket(market);

        expect(eventBus.emitEvent).toHaveBeenCalledWith('round:new', expect.objectContaining({
          roundSlug: market.slug,
        }));
      });

      it('应该触发 market:switched 事件', () => {
        const market = createMockBtc15mMarket();

        roundManager.setFromBtc15mMarket(market);

        expect(eventBus.emitEvent).toHaveBeenCalledWith('market:switched', expect.any(Object));
      });

      it('切换市场应该触发 market:switching 事件', () => {
        const market1 = createMockBtc15mMarket({ slug: 'market-1' });
        const market2 = createMockBtc15mMarket({ slug: 'market-2' });

        roundManager.setFromBtc15mMarket(market1);
        roundManager.setFromBtc15mMarket(market2);

        expect(eventBus.emitEvent).toHaveBeenCalledWith('market:switching', {
          from: 'market-1',
          to: 'market-2',
        });
      });
    });

    describe('autoTransitionToNextMarket()', () => {
      it('未启用自动发现时应返回 false', async () => {
        const result = await roundManager.autoTransitionToNextMarket();
        expect(result).toBe(false);
      });

      it('有下一市场时应成功切换', async () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        const nextMarket = createMockBtc15mMarket({ slug: 'next-market' });
        mockDiscoveryService.getNextMarket.mockReturnValue(nextMarket);

        const result = await roundManager.autoTransitionToNextMarket();

        expect(result).toBe(true);
        expect(roundManager.getCurrentRoundSlug()).toBe('next-market');
        expect(callback).toHaveBeenCalledWith(nextMarket);
      });

      it('无市场时应等待发现', async () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        mockDiscoveryService.getNextMarket.mockReturnValue(null);
        mockDiscoveryService.waitForNextMarket.mockResolvedValue(null);

        const result = await roundManager.autoTransitionToNextMarket();

        expect(result).toBe(false);
        expect(mockDiscoveryService.waitForNextMarket).toHaveBeenCalled();
      });

      it('等待后发现市场应成功切换', async () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        const nextMarket = createMockBtc15mMarket({ slug: 'discovered-market' });
        mockDiscoveryService.getNextMarket.mockReturnValue(null);
        mockDiscoveryService.waitForNextMarket.mockResolvedValue(nextMarket);

        const result = await roundManager.autoTransitionToNextMarket();

        expect(result).toBe(true);
        expect(roundManager.getCurrentRoundSlug()).toBe('discovered-market');
      });

      it('市场尚未开始应等待激活', async () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        const futureMarket = createMockBtc15mMarket({
          slug: 'future-market',
          startTime: Date.now() + 5000, // 5秒后开始
        });
        mockDiscoveryService.getNextMarket.mockReturnValue(futureMarket);

        const transitionPromise = roundManager.autoTransitionToNextMarket();

        // 推进时间
        await vi.advanceTimersByTimeAsync(6000);

        const result = await transitionPromise;
        expect(result).toBe(true);
      });

      it('并发调用应该被跳过', async () => {
        const callback = vi.fn();
        roundManager.enableAutoDiscover(callback);

        const market = createMockBtc15mMarket();
        mockDiscoveryService.getNextMarket.mockReturnValue(market);

        // 并发调用
        const promise1 = roundManager.autoTransitionToNextMarket();
        const promise2 = roundManager.autoTransitionToNextMarket();

        const [result1, result2] = await Promise.all([promise1, promise2]);

        // 第二个应该被跳过
        expect(result1).toBe(true);
        expect(result2).toBe(false);
      });
    });

    describe('发现服务访问', () => {
      it('getDiscoveryService() 未启用时应返回 null', () => {
        expect(roundManager.getDiscoveryService()).toBeNull();
      });

      it('getDiscoveryService() 启用后应返回服务实例', () => {
        roundManager.enableAutoDiscover(vi.fn());
        expect(roundManager.getDiscoveryService()).not.toBeNull();
      });

      it('getCurrentDiscoveredMarket() 应该调用服务方法', () => {
        roundManager.enableAutoDiscover(vi.fn());

        const market = createMockBtc15mMarket();
        mockDiscoveryService.getCurrentMarket.mockReturnValue(market);

        const result = roundManager.getCurrentDiscoveredMarket();
        expect(result).toEqual(market);
      });

      it('getNextDiscoveredMarket() 应该调用服务方法', () => {
        roundManager.enableAutoDiscover(vi.fn());

        const market = createMockBtc15mMarket();
        mockDiscoveryService.getNextMarket.mockReturnValue(market);

        const result = roundManager.getNextDiscoveredMarket();
        expect(result).toEqual(market);
      });

      it('refreshMarketDiscovery() 应该调用服务方法', async () => {
        roundManager.enableAutoDiscover(vi.fn());

        const market = createMockBtc15mMarket();
        mockDiscoveryService.refresh.mockResolvedValue(market);

        const result = await roundManager.refreshMarketDiscovery();
        expect(result).toEqual(market);
        expect(mockDiscoveryService.refresh).toHaveBeenCalled();
      });

      it('refreshMarketDiscovery() 未启用时应返回 null', async () => {
        const result = await roundManager.refreshMarketDiscovery();
        expect(result).toBeNull();
      });
    });
  });
});
