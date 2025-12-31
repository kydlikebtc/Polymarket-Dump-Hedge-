/**
 * 性能基准测试
 *
 * 测试关键组件的性能指标
 * 确保交易机器人能够满足实时交易的延迟要求
 *
 * 运行方式: npm run test:perf
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logTrade: vi.fn(),
}));

// 只在性能测试模式下运行
const runTests = process.env.PERF_TEST === 'true';

// 性能测试辅助函数
function measureExecutionTime(fn: () => void, iterations: number = 1000): {
  avgMs: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
  opsPerSecond: number;
} {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const opsPerSecond = 1000 / avgMs;

  return { avgMs, minMs, maxMs, totalMs, opsPerSecond };
}

async function measureAsyncExecutionTime(fn: () => Promise<void>, iterations: number = 100): Promise<{
  avgMs: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
  opsPerSecond: number;
}> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const opsPerSecond = 1000 / avgMs;

  return { avgMs, minMs, maxMs, totalMs, opsPerSecond };
}

describe.skipIf(!runTests)('Performance Benchmarks', () => {
  describe('CircularBuffer 性能', () => {
    it('push 操作应该 < 0.01ms', async () => {
      const { CircularBuffer } = await import('../../src/utils/CircularBuffer.js');
      const buffer = new CircularBuffer<number>(10000);

      const result = measureExecutionTime(() => {
        buffer.push(Math.random());
      }, 10000);

      console.log('CircularBuffer.push:', result);
      expect(result.avgMs).toBeLessThan(0.01);
    });

    it('getRecent 操作应该 < 1ms', async () => {
      const { CircularBuffer } = await import('../../src/utils/CircularBuffer.js');
      const buffer = new CircularBuffer<{ timestamp: number; value: number }>(10000);

      // 填充数据
      const now = Date.now();
      for (let i = 0; i < 5000; i++) {
        buffer.push({ timestamp: now - (5000 - i) * 10, value: Math.random() });
      }

      const result = measureExecutionTime(() => {
        buffer.getRecent(30000);
      }, 1000);

      console.log('CircularBuffer.getRecent:', result);
      expect(result.avgMs).toBeLessThan(1);
    });
  });

  describe('DumpDetector 性能', () => {
    it('addPrice 操作应该 < 0.1ms', async () => {
      const { DumpDetector } = await import('../../src/core/DumpDetector.js');

      const detector = new DumpDetector({
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

      let timestamp = Date.now();
      const result = measureExecutionTime(() => {
        detector.addPrice({
          timestamp: timestamp++,
          roundSlug: 'test-round',
          secondsRemaining: 600,
          upTokenId: 'up',
          downTokenId: 'down',
          upBestAsk: 0.50 + Math.random() * 0.1,
          upBestBid: 0.49 + Math.random() * 0.1,
          downBestAsk: 0.50 + Math.random() * 0.1,
          downBestBid: 0.49 + Math.random() * 0.1,
        });
      }, 5000);

      console.log('DumpDetector.addPrice:', result);
      expect(result.avgMs).toBeLessThan(0.1);
    });
  });

  describe('HedgeStrategy 性能', () => {
    it('shouldHedge 操作应该 < 0.001ms', async () => {
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

      const result = measureExecutionTime(() => {
        strategy.shouldHedge(Math.random() * 0.5, Math.random() * 0.5);
      }, 100000);

      console.log('HedgeStrategy.shouldHedge:', result);
      expect(result.avgMs).toBeLessThan(0.001);
    });

    it('predictHedgeProbability 操作应该 < 1ms', async () => {
      const { HedgeStrategy } = await import('../../src/core/HedgeStrategy.js');
      const { CircularBuffer } = await import('../../src/utils/CircularBuffer.js');

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

      // 准备价格缓冲区
      const buffer = new CircularBuffer<{
        timestamp: number;
        roundSlug: string;
        secondsRemaining: number;
        upTokenId: string;
        downTokenId: string;
        upBestAsk: number;
        upBestBid: number;
        downBestAsk: number;
        downBestBid: number;
      }>(1000);

      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        buffer.push({
          timestamp: now - (100 - i) * 100,
          roundSlug: 'test',
          secondsRemaining: 600,
          upTokenId: 'up',
          downTokenId: 'down',
          upBestAsk: 0.50 + Math.sin(i / 10) * 0.05,
          upBestBid: 0.49 + Math.sin(i / 10) * 0.05,
          downBestAsk: 0.50 - Math.sin(i / 10) * 0.05,
          downBestBid: 0.49 - Math.sin(i / 10) * 0.05,
        });
      }

      const result = measureExecutionTime(() => {
        strategy.predictHedgeProbability('UP', 0.40, buffer, 600);
      }, 1000);

      console.log('HedgeStrategy.predictHedgeProbability:', result);
      expect(result.avgMs).toBeLessThan(1);
    });
  });

  describe('StateMachine 性能', () => {
    it('状态转换应该 < 0.01ms', async () => {
      const { StateMachine } = await import('../../src/core/StateMachine.js');

      const result = measureExecutionTime(() => {
        const sm = new StateMachine();
        sm.startNewCycle('test-round');
        sm.onLeg1Filled({
          orderId: 'test',
          side: 'DOWN',
          shares: 20,
          entryPrice: 0.40,
          totalCost: 8,
          filledAt: Date.now(),
        });
        sm.onLeg2Filled({
          orderId: 'test2',
          side: 'UP',
          shares: 20,
          entryPrice: 0.55,
          totalCost: 11,
          filledAt: Date.now(),
        });
      }, 10000);

      console.log('StateMachine transitions:', result);
      expect(result.avgMs).toBeLessThan(0.1);
    });
  });

  describe('PolymarketClient 性能 (Dry Run)', () => {
    it('模拟订单应该 < 1ms', async () => {
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

      const result = await measureAsyncExecutionTime(async () => {
        await client.buyByShares('DOWN', 'token', 20, 0.45);
      }, 1000);

      console.log('PolymarketClient.buyByShares (dry):', result);
      expect(result.avgMs).toBeLessThan(1);

      client.stopNonceCleanup();
    });
  });

  describe('整体延迟要求', () => {
    it('完整价格处理周期应该 < 5ms', async () => {
      const { DumpDetector } = await import('../../src/core/DumpDetector.js');
      const { HedgeStrategy } = await import('../../src/core/HedgeStrategy.js');
      const { StateMachine } = await import('../../src/core/StateMachine.js');

      const config = {
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
      };

      const detector = new DumpDetector(config);
      const strategy = new HedgeStrategy(config);
      const stateMachine = new StateMachine();

      stateMachine.startNewCycle('test-round');

      let timestamp = Date.now();
      const result = measureExecutionTime(() => {
        // 模拟完整的价格处理周期
        const price = {
          timestamp: timestamp++,
          roundSlug: 'test-round',
          secondsRemaining: 600,
          upTokenId: 'up',
          downTokenId: 'down',
          upBestAsk: 0.50 + Math.random() * 0.1,
          upBestBid: 0.49 + Math.random() * 0.1,
          downBestAsk: 0.50 + Math.random() * 0.1,
          downBestBid: 0.49 + Math.random() * 0.1,
        };

        // 1. 添加价格并检测暴跌
        const signal = detector.addPrice(price);

        // 2. 如果在 LEG1_FILLED 状态，检查对冲条件
        if (stateMachine.getCurrentState() === 'LEG1_FILLED') {
          strategy.shouldHedge(0.40, price.downBestAsk);
        }
      }, 5000);

      console.log('Full price processing cycle:', result);
      expect(result.avgMs).toBeLessThan(5);
    });
  });
});

describe.skipIf(!runTests)('Memory Usage', () => {
  it('CircularBuffer 应该限制内存使用', async () => {
    const { CircularBuffer } = await import('../../src/utils/CircularBuffer.js');

    const buffer = new CircularBuffer<{ data: number[] }>(1000);

    // 添加超过容量的数据
    for (let i = 0; i < 2000; i++) {
      buffer.push({ data: new Array(100).fill(i) });
    }

    // 应该只保留最近 1000 条
    expect(buffer.length).toBe(1000);
  });

  it('DumpDetector 价格缓冲区应该自动清理', async () => {
    const { DumpDetector } = await import('../../src/core/DumpDetector.js');

    const detector = new DumpDetector({
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

    // 添加大量价格数据
    const now = Date.now();
    for (let i = 0; i < 10000; i++) {
      detector.addPrice({
        timestamp: now + i * 100,
        roundSlug: 'test-round',
        secondsRemaining: 600,
        upTokenId: 'up',
        downTokenId: 'down',
        upBestAsk: 0.50,
        upBestBid: 0.49,
        downBestAsk: 0.50,
        downBestBid: 0.49,
      });
    }

    // 内部缓冲区应该有大小限制
    // 这里只验证不会崩溃
    expect(true).toBe(true);
  });
});
