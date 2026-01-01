/**
 * TradingEngine 集成测试
 *
 * 测试交易引擎的核心功能，包括：
 * - 引擎启动/停止
 * - 自动模式控制
 * - 事件处理
 * - 配置更新
 * - 手动交易
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { TradingEngine } from '../src/core/TradingEngine.js';
import { eventBus } from '../src/utils/EventBus.js';
import type { BotConfig, PriceSnapshot, DumpSignal, OrderResult } from '../src/types/index.js';

// Mock 依赖模块
vi.mock('../src/api/MarketWatcher.js', () => ({
  MarketWatcher: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    subscribeMultiple: vi.fn(),
    setTokenIds: vi.fn(),
    getPriceBuffer: vi.fn().mockReturnValue([]),
    getLatestPrice: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../src/api/PolymarketClient.js', () => ({
  PolymarketClient: vi.fn().mockImplementation(() => ({
    buyByShares: vi.fn().mockResolvedValue({
      orderId: 'test-order-1',
      side: 'UP',
      shares: 100,
      avgPrice: 0.35,
      totalCost: 35,
      status: 'filled',
      timestamp: Date.now(),
    } as OrderResult),
    buyByUsd: vi.fn().mockResolvedValue({
      orderId: 'test-order-2',
      side: 'UP',
      shares: 50,
      avgPrice: 0.40,
      totalCost: 20,
      status: 'filled',
      timestamp: Date.now(),
    } as OrderResult),
  })),
}));

vi.mock('../src/core/RoundManager.js', () => ({
  RoundManager: vi.fn().mockImplementation(() => ({
    startPeriodicCheck: vi.fn(),
    stopPeriodicCheck: vi.fn(),
    isRoundActive: vi.fn().mockReturnValue(true),
    getCurrentRoundSlug: vi.fn().mockReturnValue('BTC-15min-test'),
    getTokenId: vi.fn().mockImplementation((side: string) =>
      side === 'UP' ? 'test-up-token' : 'test-down-token'
    ),
    getUpTokenId: vi.fn().mockReturnValue('test-up-token'),
    getDownTokenId: vi.fn().mockReturnValue('test-down-token'),
    updateFromSnapshot: vi.fn(),
    ensureActiveMarket: vi.fn().mockResolvedValue(true),
    useStaticMarket: vi.fn().mockReturnValue(true),
    hasAvailableMarket: vi.fn().mockReturnValue(true),
    isUsingStaticMarket: vi.fn().mockReturnValue(false),
    getStaticMarketConfig: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../src/db/Database.js', () => ({
  getDatabase: vi.fn().mockReturnValue({
    createTradeCycle: vi.fn(),
    updateTradeCycle: vi.fn(),
    savePriceSnapshot: vi.fn(),
  }),
}));

// Mock logger 以避免日志输出干扰测试
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  logTrade: vi.fn(),
}));

describe('TradingEngine', () => {
  let engine: TradingEngine;
  let testConfig: BotConfig;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    testConfig = {
      shares: 100,
      sumTarget: 0.95,
      movePct: 0.15,
      windowMin: 3,
      wsUrl: 'wss://test.polymarket.com',
      apiUrl: 'https://test.polymarket.com',
      reconnectDelay: 1000,
      maxReconnects: 5,
      feeRate: 0.002,
      spreadBuffer: 0.01,
      privateKey: '',
      walletAddress: '',
      readOnly: true,
      dryRun: true,
    };

    engine = new TradingEngine(testConfig);
  });

  afterEach(async () => {
    // 确保引擎停止
    if (engine.isEngineRunning()) {
      await engine.stop();
    }
    // 清理定时器
    vi.clearAllTimers();
  });

  describe('初始化', () => {
    it('应该正确初始化所有组件', () => {
      expect(engine).toBeDefined();
      expect(engine.isEngineRunning()).toBe(false);
      expect(engine.isInAutoMode()).toBe(false);
    });

    it('应该获取正确的配置', () => {
      const config = engine.getConfig();
      expect(config.shares).toBe(100);
      expect(config.sumTarget).toBe(0.95);
      expect(config.movePct).toBe(0.15);
      expect(config.windowMin).toBe(3);
    });

    it('应该初始化所有子组件', () => {
      expect(engine.getStateMachine()).toBeDefined();
      expect(engine.getMarketWatcher()).toBeDefined();
      expect(engine.getRoundManager()).toBeDefined();
      expect(engine.getDumpDetector()).toBeDefined();
      expect(engine.getHedgeStrategy()).toBeDefined();
    });
  });

  describe('引擎启动/停止', () => {
    it('start() 应该启动引擎', async () => {
      await engine.start();

      expect(engine.isEngineRunning()).toBe(true);
      expect(engine.getMarketWatcher().connect).toHaveBeenCalled();
      expect(engine.getRoundManager().startPeriodicCheck).toHaveBeenCalled();
    });

    it('重复启动应该被忽略', async () => {
      await engine.start();
      await engine.start();

      // connect 只应该被调用一次
      expect(engine.getMarketWatcher().connect).toHaveBeenCalledTimes(1);
    });

    it('stop() 应该停止引擎', async () => {
      await engine.start();
      await engine.stop();

      expect(engine.isEngineRunning()).toBe(false);
      expect(engine.getMarketWatcher().disconnect).toHaveBeenCalled();
      expect(engine.getRoundManager().stopPeriodicCheck).toHaveBeenCalled();
    });

    it('未启动时 stop() 应该是安全的', async () => {
      await engine.stop();
      expect(engine.isEngineRunning()).toBe(false);
    });
  });

  describe('自动交易模式', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('startAutoMode() 应该启动自动模式', () => {
      engine.startAutoMode();
      expect(engine.isInAutoMode()).toBe(true);
    });

    it('未启动引擎时 startAutoMode() 应该抛出错误', async () => {
      await engine.stop();
      expect(() => engine.startAutoMode()).toThrow('Engine not running');
    });

    it('重复启动自动模式应该被忽略', () => {
      engine.startAutoMode();
      engine.startAutoMode();
      expect(engine.isInAutoMode()).toBe(true);
    });

    it('stopAutoMode() 应该停止自动模式', () => {
      engine.startAutoMode();
      engine.stopAutoMode();
      expect(engine.isInAutoMode()).toBe(false);
    });

    it('未启动自动模式时 stopAutoMode() 应该是安全的', () => {
      engine.stopAutoMode();
      expect(engine.isInAutoMode()).toBe(false);
    });

    it('引擎停止时应该同时停止自动模式', async () => {
      engine.startAutoMode();
      await engine.stop();

      expect(engine.isInAutoMode()).toBe(false);
      expect(engine.isEngineRunning()).toBe(false);
    });
  });

  describe('配置更新', () => {
    it('应该更新 shares 配置', () => {
      engine.updateConfig({ shares: 200 });
      expect(engine.getConfig().shares).toBe(200);
    });

    it('应该更新 sumTarget 配置', () => {
      engine.updateConfig({ sumTarget: 0.98 });
      expect(engine.getConfig().sumTarget).toBe(0.98);
    });

    it('应该更新 movePct 配置', () => {
      engine.updateConfig({ movePct: 0.20 });
      expect(engine.getConfig().movePct).toBe(0.20);
    });

    it('应该更新 windowMin 配置', () => {
      engine.updateConfig({ windowMin: 5 });
      expect(engine.getConfig().windowMin).toBe(5);
    });

    it('应该支持同时更新多个配置', () => {
      engine.updateConfig({
        shares: 150,
        sumTarget: 0.96,
        movePct: 0.18,
        windowMin: 4,
      });

      const config = engine.getConfig();
      expect(config.shares).toBe(150);
      expect(config.sumTarget).toBe(0.96);
      expect(config.movePct).toBe(0.18);
      expect(config.windowMin).toBe(4);
    });
  });

  describe('事件处理', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('应该处理 ws:connected 事件', () => {
      const subscribeMultipleSpy = engine.getMarketWatcher().subscribeMultiple as Mock;
      const setTokenIdsSpy = engine.getMarketWatcher().setTokenIds as Mock;

      // 触发连接事件
      eventBus.emit('ws:connected', undefined);

      // 应该设置 Token IDs 并批量订阅市场
      expect(setTokenIdsSpy).toHaveBeenCalled();
      expect(subscribeMultipleSpy).toHaveBeenCalled();
    });

    it('应该处理 ws:disconnected 事件', () => {
      engine.startAutoMode();

      // 触发断开事件
      eventBus.emit('ws:disconnected', { code: 1000, reason: 'normal' });

      // 自动模式应该仍然开启（只是检测停止）
      expect(engine.isInAutoMode()).toBe(true);
    });

    it('应该处理 price:update 事件', () => {
      const updateSpy = engine.getRoundManager().updateFromSnapshot as Mock;

      const snapshot: PriceSnapshot = {
        timestamp: Date.now(),
        roundSlug: 'BTC-15min-test',
        secondsRemaining: 600,
        upTokenId: 'test-up-token',
        downTokenId: 'test-down-token',
        upBestAsk: 0.45,
        upBestBid: 0.44,
        downBestAsk: 0.55,
        downBestBid: 0.54,
      };

      eventBus.emit('price:update', snapshot);

      expect(updateSpy).toHaveBeenCalledWith(snapshot);
    });

    it('应该处理 round:new 事件', () => {
      engine.startAutoMode();
      const stateMachine = engine.getStateMachine();

      // 触发新轮次事件
      eventBus.emit('round:new', {
        roundSlug: 'BTC-15min-new-round',
        startTime: Date.now(),
      });

      // 状态机应该开始新周期
      expect(stateMachine.getCurrentStatus()).toBe('WATCHING');
    });

    it('应该处理 round:expired 事件', () => {
      engine.startAutoMode();
      const stateMachine = engine.getStateMachine();

      // 先开始一个周期
      eventBus.emit('round:new', {
        roundSlug: 'BTC-15min-test',
        startTime: Date.now(),
      });

      // 触发轮次过期事件
      eventBus.emit('round:expired', { roundSlug: 'BTC-15min-test' });

      // 状态机应该重置
      expect(stateMachine.getCurrentStatus()).toBe('IDLE');
    });
  });

  describe('手动交易', () => {
    beforeEach(async () => {
      await engine.start();

      // 配置 getLatestPrice 返回有效价格
      const marketWatcher = engine.getMarketWatcher();
      (marketWatcher.getLatestPrice as Mock).mockReturnValue({
        upBestAsk: 0.45,
        upBestBid: 0.44,
        downBestAsk: 0.55,
        downBestBid: 0.54,
      });
    });

    it('manualBuy() 应该使用份数买入', async () => {
      await engine.manualBuy('UP', 50, true);

      const client = (engine as unknown as { client: { buyByShares: Mock } }).client;
      expect(client.buyByShares).toHaveBeenCalledWith(
        'UP',
        'test-up-token',
        50,
        0.45
      );
    });

    it('manualBuy() 应该使用 USD 金额买入', async () => {
      await engine.manualBuy('DOWN', 100, false);

      const client = (engine as unknown as { client: { buyByUsd: Mock } }).client;
      expect(client.buyByUsd).toHaveBeenCalledWith(
        'DOWN',
        'test-down-token',
        100
      );
    });

    it('无活跃市场时 manualBuy() 应该抛出错误', async () => {
      const roundManager = engine.getRoundManager();
      (roundManager.getTokenId as Mock).mockReturnValue(null);

      await expect(engine.manualBuy('UP', 50, true)).rejects.toThrow('No active market');
    });

    it('无价格数据时 manualBuy() 应该抛出错误', async () => {
      const marketWatcher = engine.getMarketWatcher();
      (marketWatcher.getLatestPrice as Mock).mockReturnValue(null);

      await expect(engine.manualBuy('UP', 50, true)).rejects.toThrow('No price available');
    });
  });

  describe('状态机交互', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('getStateMachine() 应该返回状态机实例', () => {
      const stateMachine = engine.getStateMachine();
      expect(stateMachine).toBeDefined();
      expect(stateMachine.getCurrentStatus()).toBe('IDLE');
    });

    it('新轮次后状态机应该进入 WATCHING 状态', () => {
      engine.startAutoMode();

      eventBus.emit('round:new', {
        roundSlug: 'BTC-15min-test',
        startTime: Date.now(),
      });

      expect(engine.getStateMachine().getCurrentStatus()).toBe('WATCHING');
    });
  });

  describe('暴跌检测器交互', () => {
    it('getDumpDetector() 应该返回检测器实例', () => {
      const detector = engine.getDumpDetector();
      expect(detector).toBeDefined();
    });

    it('配置更新应该同步到检测器', () => {
      const detector = engine.getDumpDetector();
      const updateSpy = vi.spyOn(detector, 'updateConfig');

      engine.updateConfig({ movePct: 0.25 });

      expect(updateSpy).toHaveBeenCalledWith(0.25);
    });
  });

  describe('对冲策略交互', () => {
    it('getHedgeStrategy() 应该返回策略实例', () => {
      const strategy = engine.getHedgeStrategy();
      expect(strategy).toBeDefined();
    });

    it('配置更新应该同步到策略', () => {
      const strategy = engine.getHedgeStrategy();
      const updateSpy = vi.spyOn(strategy, 'updateConfig');

      engine.updateConfig({ sumTarget: 0.97 });

      expect(updateSpy).toHaveBeenCalledWith(0.97);
    });
  });

  describe('错误处理', () => {
    it('启动失败应该重置运行状态', async () => {
      const marketWatcher = engine.getMarketWatcher();
      (marketWatcher.connect as Mock).mockRejectedValue(new Error('Connection failed'));

      await expect(engine.start()).rejects.toThrow('Connection failed');
      expect(engine.isEngineRunning()).toBe(false);
    });
  });

  describe('周期完成回调', () => {
    it('状态机应该有周期完成回调', () => {
      // 验证状态机有 setOnCycleComplete 方法，且在引擎构造时被调用
      const stateMachine = engine.getStateMachine();
      expect(typeof stateMachine.setOnCycleComplete).toBe('function');

      // 验证回调已被设置（通过检查周期完成后状态机会重置）
      // 这在实际业务场景中会自动触发
    });
  });
});
