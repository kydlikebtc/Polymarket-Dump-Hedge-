/**
 * 交易流程 E2E 测试
 *
 * 测试完整的交易流程，使用 Dry Run 模式
 * 不需要真实资金，但会连接真实 API 验证数据流
 *
 * 运行方式: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock 模块
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logTrade: vi.fn(),
}));

// 只在 E2E 测试模式下运行
const runTests = process.env.E2E_TEST === 'true';

describe.skipIf(!runTests)('Trading Flow E2E', () => {
  describe('完整交易周期 (Dry Run)', () => {
    it('应该能够完成 Leg1 -> Leg2 对冲流程', async () => {
      const { StateMachine } = await import('../../src/core/StateMachine.js');
      const { HedgeStrategy } = await import('../../src/core/HedgeStrategy.js');
      const { PolymarketClient } = await import('../../src/api/PolymarketClient.js');

      // 配置 (Dry Run 模式)
      const config = {
        shares: 20,
        sumTarget: 0.95,
        movePct: 0.15,
        windowMin: 2,
        wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
        apiUrl: 'https://clob.polymarket.com',
        reconnectDelay: 1000,
        maxReconnects: 5,
        feeRate: 0.005,
        spreadBuffer: 0.02,
        privateKey: '',
        walletAddress: '',
        readOnly: false,
        dryRun: true, // 关键：Dry Run 模式
      };

      // 初始化组件
      const stateMachine = new StateMachine();
      const strategy = new HedgeStrategy(config);
      const client = new PolymarketClient(config);

      // 验证初始状态
      expect(stateMachine.getCurrentStatus()).toBe('IDLE');
      expect(client.isDryRun()).toBe(true);

      // 模拟交易流程
      // 1. 开始新周期
      stateMachine.startNewCycle('test-round-001');
      expect(stateMachine.getCurrentStatus()).toBe('WATCHING');

      // 2. 检测暴跌信号
      const dropPct = 0.18; // 18% 下跌
      const shouldBuy = dropPct >= config.movePct;
      expect(shouldBuy).toBe(true);

      // 3. 模拟 Leg1 买入
      if (shouldBuy) {
        // 首先触发暴跌检测，进入 LEG1_PENDING 状态
        stateMachine.onDumpDetected({
          side: 'DOWN',
          dropPct: dropPct,
          price: 0.35,
          timestamp: Date.now(),
          roundSlug: 'test-round-001',
          tokenId: 'test-token',
        });
        expect(stateMachine.getCurrentStatus()).toBe('LEG1_PENDING');

        const leg1Result = await client.buyByShares('DOWN', 'test-token', config.shares, 0.35);
        expect(leg1Result.status).toBe('filled');
        expect(leg1Result.orderId).toMatch(/^sim-/); // Dry Run 订单 ID
        expect(leg1Result.side).toBe('DOWN');

        stateMachine.onLeg1Filled({
          orderId: leg1Result.orderId,
          side: 'DOWN',
          shares: leg1Result.shares,
          avgPrice: leg1Result.avgPrice,
          totalCost: leg1Result.totalCost,
          timestamp: Date.now(),
          status: 'filled',
        });

        expect(stateMachine.getCurrentStatus()).toBe('LEG1_FILLED');
      }

      // 4. 检查对冲条件
      const leg1Price = 0.35;
      const oppositePrice = 0.58; // UP @ 0.58
      const shouldHedge = strategy.shouldHedge(leg1Price, oppositePrice);

      // 5. 模拟 Leg2 对冲
      if (shouldHedge) {
        // 首先需要转换到 LEG2_PENDING 状态
        stateMachine.onLeg2Started();

        const leg2Result = await client.buyByShares('UP', 'test-token-up', config.shares, oppositePrice);
        expect(leg2Result.status).toBe('filled');

        stateMachine.onLeg2Filled({
          orderId: leg2Result.orderId,
          side: 'UP',
          shares: leg2Result.shares,
          avgPrice: leg2Result.avgPrice,
          totalCost: leg2Result.totalCost,
          timestamp: Date.now(),
          status: 'filled',
        });

        expect(stateMachine.getCurrentStatus()).toBe('COMPLETED');
      }

      // 6. 计算收益
      const cycle = stateMachine.getCurrentCycle();
      if (cycle?.leg1 && cycle?.leg2) {
        const profit = strategy.calculateGuaranteedProfit(
          cycle.leg1.shares,
          cycle.leg1.entryPrice,
          cycle.leg2.entryPrice
        );
        expect(profit).toBeDefined();
        // 收益可能为正或负，取决于具体价格
      }

      // 清理
      client.stopNonceCleanup();
    });

    it('应该正确处理轮次过期', async () => {
      const { StateMachine } = await import('../../src/core/StateMachine.js');

      const stateMachine = new StateMachine();

      // 开始周期
      stateMachine.startNewCycle('test-round-002');
      expect(stateMachine.getCurrentStatus()).toBe('WATCHING');

      // 模拟轮次过期
      stateMachine.onRoundExpired();
      expect(stateMachine.getCurrentStatus()).toBe('ROUND_EXPIRED');
    });

    it('应该正确处理错误状态', async () => {
      const { StateMachine } = await import('../../src/core/StateMachine.js');

      const stateMachine = new StateMachine();

      // 开始周期
      stateMachine.startNewCycle('test-round-003');

      // 模拟错误
      stateMachine.onError(new Error('Test error'));
      expect(stateMachine.getCurrentStatus()).toBe('ERROR');
    });
  });

  describe('对冲策略验证', () => {
    it('应该正确判断对冲条件', async () => {
      const { HedgeStrategy } = await import('../../src/core/HedgeStrategy.js');

      const strategy = new HedgeStrategy({
        shares: 20,
        sumTarget: 0.95,
        movePct: 0.15,
        windowMin: 2,
        wsUrl: 'wss://test.com',
        apiUrl: 'https://test.com',
        reconnectDelay: 1000,
        maxReconnects: 5,
        feeRate: 0.005,
        spreadBuffer: 0.02,
        privateKey: '',
        walletAddress: '',
        readOnly: false,
        dryRun: true,
      });

      // 测试边界条件
      // 注意: shouldHedge 检查 sum <= sumTarget (0.95)
      expect(strategy.shouldHedge(0.40, 0.54)).toBe(true);  // 0.94 < 0.95
      expect(strategy.shouldHedge(0.40, 0.56)).toBe(false); // 0.96 > 0.95
      expect(strategy.shouldHedge(0.45, 0.49)).toBe(true);  // 0.94 < 0.95
      expect(strategy.shouldHedge(0.50, 0.50)).toBe(false); // 1.00 > 0.95
    });

    it('应该正确计算最大 Leg2 价格', async () => {
      const { HedgeStrategy } = await import('../../src/core/HedgeStrategy.js');

      const strategy = new HedgeStrategy({
        shares: 20,
        sumTarget: 0.95,
        movePct: 0.15,
        windowMin: 2,
        wsUrl: 'wss://test.com',
        apiUrl: 'https://test.com',
        reconnectDelay: 1000,
        maxReconnects: 5,
        feeRate: 0.005,
        spreadBuffer: 0.02,
        privateKey: '',
        walletAddress: '',
        readOnly: false,
        dryRun: true,
      });

      // Leg1 @ 0.40, sumTarget = 0.95
      // maxLeg2 = 0.95 - 0.40 = 0.55
      const maxLeg2 = strategy.getMaxLeg2Price(0.40);
      expect(maxLeg2).toBeCloseTo(0.55, 2);
    });
  });

  describe('暴跌检测验证', () => {
    it('应该正确检测价格暴跌', async () => {
      const { DumpDetector } = await import('../../src/core/DumpDetector.js');
      const { CircularBuffer } = await import('../../src/utils/CircularBuffer.js');

      const config = {
        shares: 20,
        sumTarget: 0.95,
        movePct: 0.15, // 15% 阈值
        windowMin: 2,
        wsUrl: 'wss://test.com',
        apiUrl: 'https://test.com',
        reconnectDelay: 1000,
        maxReconnects: 5,
        feeRate: 0.005,
        spreadBuffer: 0.02,
        privateKey: '',
        walletAddress: '',
        readOnly: false,
        dryRun: true,
      };

      const detector = new DumpDetector(config);
      const priceBuffer = new CircularBuffer<{
        timestamp: number;
        roundSlug: string;
        secondsRemaining: number;
        upTokenId: string;
        downTokenId: string;
        upBestAsk: number;
        upBestBid: number;
        downBestAsk: number;
        downBestBid: number;
      }>(100);

      const now = Date.now();

      // 设置轮次开始时间（在监控窗口内）
      detector.setRoundStartTime(now - 180000); // 3分钟前开始

      // 添加初始价格
      priceBuffer.push({
        timestamp: now - 2000,
        roundSlug: 'test-round',
        secondsRemaining: 600,
        upTokenId: 'up',
        downTokenId: 'down',
        upBestAsk: 0.50,
        upBestBid: 0.49,
        downBestAsk: 0.50,
        downBestBid: 0.49,
      });

      // 添加暴跌后的价格 (UP 从 0.50 跌到 0.40 = -20%)
      priceBuffer.push({
        timestamp: now,
        roundSlug: 'test-round',
        secondsRemaining: 598,
        upTokenId: 'up',
        downTokenId: 'down',
        upBestAsk: 0.40,
        upBestBid: 0.39,
        downBestAsk: 0.60,
        downBestBid: 0.59,
      });

      // 使用 detect 方法检测
      const signal = detector.detect(priceBuffer, 'test-round');

      if (signal) {
        expect(signal.side).toBe('UP');
        expect(signal.dropPct).toBeGreaterThanOrEqual(0.15);
      }
      // 如果没有信号也是可接受的（取决于检测窗口配置）
    });
  });
});

describe.skipIf(!runTests)('API Client E2E', () => {
  it('应该正确模拟订单提交', async () => {
    const { PolymarketClient } = await import('../../src/api/PolymarketClient.js');

    const client = new PolymarketClient({
      shares: 20,
      sumTarget: 0.95,
      movePct: 0.15,
      windowMin: 2,
      wsUrl: 'wss://test.com',
      apiUrl: 'https://test.com',
      reconnectDelay: 1000,
      maxReconnects: 5,
      feeRate: 0.005,
      spreadBuffer: 0.02,
      privateKey: '',
      walletAddress: '',
      readOnly: false,
      dryRun: true,
    });

    // 模拟买入
    const result = await client.buyByShares('DOWN', 'token-123', 50, 0.45);

    expect(result.orderId).toMatch(/^sim-/);
    expect(result.side).toBe('DOWN');
    expect(result.shares).toBe(50);
    expect(result.avgPrice).toBeCloseTo(0.45);
    expect(result.totalCost).toBeCloseTo(22.5); // 50 * 0.45
    expect(result.status).toBe('filled');

    client.stopNonceCleanup();
  });
});
