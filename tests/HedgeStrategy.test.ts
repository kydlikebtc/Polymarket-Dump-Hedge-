/**
 * HedgeStrategy 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HedgeStrategy } from '../src/core/HedgeStrategy.js';
import { CircularBuffer } from '../src/utils/CircularBuffer.js';
import { BotConfig, LegInfo, PriceSnapshot } from '../src/types/index.js';

describe('HedgeStrategy', () => {
  let strategy: HedgeStrategy;

  // 测试配置
  const testConfig: BotConfig = {
    tokenIdUp: 'test-up',
    tokenIdDown: 'test-down',
    conditionId: 'test-condition',
    wsUrl: 'wss://test.com',
    apiUrl: 'https://test.com',
    privateKey: '',
    movePct: 0.15,
    windowMin: 10,
    sumTarget: 0.95,
    shares: 100,
    feeRate: 0.002, // 0.2%
    dryRun: true,
    dbPath: ':memory:',
  };

  beforeEach(() => {
    strategy = new HedgeStrategy(testConfig);
  });

  describe('shouldHedge() - 对冲条件判断', () => {
    it('应该在 sum <= sumTarget 时返回 true', () => {
      // Leg1 买入价 0.5, 对手盘 ask 0.45, sum = 0.95
      expect(strategy.shouldHedge(0.5, 0.45)).toBe(true);

      // Leg1 买入价 0.4, 对手盘 ask 0.5, sum = 0.9
      expect(strategy.shouldHedge(0.4, 0.5)).toBe(true);

      // Leg1 买入价 0.48, 对手盘 ask 0.47, sum = 0.95 (刚好等于)
      expect(strategy.shouldHedge(0.48, 0.47)).toBe(true);
    });

    it('应该在 sum > sumTarget 时返回 false', () => {
      // Leg1 买入价 0.5, 对手盘 ask 0.5, sum = 1.0
      expect(strategy.shouldHedge(0.5, 0.5)).toBe(false);

      // Leg1 买入价 0.55, 对手盘 ask 0.45, sum = 1.0
      expect(strategy.shouldHedge(0.55, 0.45)).toBe(false);

      // Leg1 买入价 0.5, 对手盘 ask 0.46, sum = 0.96
      expect(strategy.shouldHedge(0.5, 0.46)).toBe(false);
    });
  });

  describe('calculateGuaranteedProfit() - 利润计算', () => {
    it('应该正确计算毛利润', () => {
      // 100 shares, Leg1 @ 0.4, Leg2 @ 0.5
      // 结算时获得 100 * 1 = $100
      // 成本 = (0.4 + 0.5) * 100 = $90
      // 毛利润 = $100 - $90 = $10
      const result = strategy.calculateGuaranteedProfit(0.4, 0.5, 100);
      expect(result.grossProfit).toBeCloseTo(10, 2);
    });

    it('应该正确计算手续费', () => {
      const result = strategy.calculateGuaranteedProfit(0.4, 0.5, 100);
      // 手续费 = (0.4 + 0.5) * 100 * 0.002 * 2 = $0.36
      expect(result.fees).toBeCloseTo(0.36, 2);
    });

    it('应该正确计算净利润', () => {
      const result = strategy.calculateGuaranteedProfit(0.4, 0.5, 100);
      // 净利润 = 毛利润 - 手续费 = $10 - $0.36 = $9.64
      expect(result.netProfit).toBeCloseTo(9.64, 2);
    });

    it('边界情况: sum = 0.95 时的利润', () => {
      // 100 shares, Leg1 @ 0.45, Leg2 @ 0.5, sum = 0.95
      // 毛利润 = 100 - 95 = $5
      const result = strategy.calculateGuaranteedProfit(0.45, 0.5, 100);
      expect(result.grossProfit).toBeCloseTo(5, 2);
    });

    it('亏损情况: sum > 1 时应该为负', () => {
      // 100 shares, Leg1 @ 0.55, Leg2 @ 0.5, sum = 1.05
      // 毛利润 = 100 - 105 = -$5
      const result = strategy.calculateGuaranteedProfit(0.55, 0.5, 100);
      expect(result.grossProfit).toBeLessThan(0);
    });
  });

  describe('getMaxLeg2Price() - 最大 Leg2 价格', () => {
    it('应该返回正确的最大价格', () => {
      // sumTarget = 0.95, Leg1 @ 0.4
      // 最大 Leg2 = 0.95 - 0.4 = 0.55
      expect(strategy.getMaxLeg2Price(0.4)).toBeCloseTo(0.55, 4);
    });

    it('Leg1 越低，允许的 Leg2 越高', () => {
      expect(strategy.getMaxLeg2Price(0.3)).toBeCloseTo(0.65, 4);
      expect(strategy.getMaxLeg2Price(0.5)).toBeCloseTo(0.45, 4);
    });
  });

  describe('simulateHedge() - 模拟对冲', () => {
    it('应该正确模拟 UP -> DOWN 对冲', () => {
      const result = strategy.simulateHedge('UP', 0.4, 0.5, 100);

      expect(result.leg1.side).toBe('UP');
      expect(result.leg2.side).toBe('DOWN');
      expect(result.leg1.price).toBe(0.4);
      expect(result.leg2.price).toBe(0.5);
      expect(result.totalCost).toBe(90);
      expect(result.guaranteedReturn).toBe(100);
      expect(result.grossProfit).toBe(10);
    });

    it('应该正确模拟 DOWN -> UP 对冲', () => {
      const result = strategy.simulateHedge('DOWN', 0.35, 0.55, 100);

      expect(result.leg1.side).toBe('DOWN');
      expect(result.leg2.side).toBe('UP');
      expect(result.totalCost).toBe(90);
      expect(result.grossProfit).toBe(10);
    });
  });

  describe('calculateHedge() - 对冲计算', () => {
    it('应该正确计算对冲详情', () => {
      const leg1: LegInfo = {
        orderId: 'test-order',
        side: 'UP',
        shares: 100,
        entryPrice: 0.4,
        totalCost: 40,
        filledAt: Date.now(),
      };

      const currentPrice: PriceSnapshot = {
        timestamp: Date.now(),
        upBestBid: 0.39,
        upBestAsk: 0.41,
        downBestBid: 0.49,
        downBestAsk: 0.5,
      };

      const calc = strategy.calculateHedge(leg1, currentPrice);

      expect(calc.shouldHedge).toBe(true); // 0.4 + 0.5 = 0.9 <= 0.95
      expect(calc.currentSum).toBeCloseTo(0.9, 4);
      expect(calc.oppositePrice).toBe(0.5);
      expect(calc.potentialProfit).toBeGreaterThan(0);
    });

    it('对冲条件不满足时 shouldHedge 为 false', () => {
      const leg1: LegInfo = {
        orderId: 'test-order',
        side: 'UP',
        shares: 100,
        entryPrice: 0.5,
        totalCost: 50,
        filledAt: Date.now(),
      };

      const currentPrice: PriceSnapshot = {
        timestamp: Date.now(),
        upBestBid: 0.49,
        upBestAsk: 0.51,
        downBestBid: 0.49,
        downBestAsk: 0.5,
      };

      const calc = strategy.calculateHedge(leg1, currentPrice);

      expect(calc.shouldHedge).toBe(false); // 0.5 + 0.5 = 1.0 > 0.95
      expect(calc.currentSum).toBeCloseTo(1.0, 4);
    });
  });

  describe('配置相关', () => {
    it('getConfig() 应该返回当前配置', () => {
      const config = strategy.getConfig();
      expect(config.sumTarget).toBe(0.95);
      expect(config.shares).toBe(100);
      expect(config.feeRate).toBe(0.002);
    });

    it('updateConfig() 应该更新配置', () => {
      strategy.updateConfig(0.93, 200);
      const config = strategy.getConfig();
      expect(config.sumTarget).toBe(0.93);
      expect(config.shares).toBe(200);
    });

    it('无效的 sumTarget 应该抛出错误', () => {
      expect(() => strategy.updateConfig(0.3)).toThrow();
      expect(() => strategy.updateConfig(1.1)).toThrow();
    });

    it('无效的 shares 应该抛出错误', () => {
      expect(() => strategy.updateConfig(undefined, 0)).toThrow();
      expect(() => strategy.updateConfig(undefined, -10)).toThrow();
    });
  });

  describe('不同 sumTarget 配置', () => {
    it('sumTarget = 0.93 应该更严格', () => {
      // 创建独立的配置副本，避免受其他测试影响
      const freshConfig: BotConfig = {
        tokenIdUp: 'test-up',
        tokenIdDown: 'test-down',
        conditionId: 'test-condition',
        wsUrl: 'wss://test.com',
        apiUrl: 'https://test.com',
        privateKey: '',
        movePct: 0.15,
        windowMin: 10,
        sumTarget: 0.95,
        shares: 100,
        feeRate: 0.002,
        dryRun: true,
        dbPath: ':memory:',
      };
      const defaultStrategy = new HedgeStrategy(freshConfig);
      const strictConfig: BotConfig = { ...freshConfig, sumTarget: 0.93 };
      const strictStrategy = new HedgeStrategy(strictConfig);

      // sum = 0.875, 对于 0.95 和 0.93 target 都是有效的 (使用二进制精确值)
      expect(defaultStrategy.shouldHedge(0.375, 0.5)).toBe(true); // 0.875 <= 0.95
      expect(strictStrategy.shouldHedge(0.375, 0.5)).toBe(true); // 0.875 <= 0.93

      // sum = 0.9375, 对于 0.95 target 有效，对于 0.93 target 无效 (使用二进制精确值)
      expect(defaultStrategy.shouldHedge(0.4375, 0.5)).toBe(true); // 0.9375 <= 0.95
      expect(strictStrategy.shouldHedge(0.4375, 0.5)).toBe(false); // 0.9375 > 0.93
    });

    it('sumTarget = 0.98 应该更宽松', () => {
      // 创建独立的配置副本，避免受其他测试影响
      const freshConfig: BotConfig = {
        tokenIdUp: 'test-up',
        tokenIdDown: 'test-down',
        conditionId: 'test-condition',
        wsUrl: 'wss://test.com',
        apiUrl: 'https://test.com',
        privateKey: '',
        movePct: 0.15,
        windowMin: 10,
        sumTarget: 0.95,
        shares: 100,
        feeRate: 0.002,
        dryRun: true,
        dbPath: ':memory:',
      };
      const defaultStrategy = new HedgeStrategy(freshConfig);
      const looseConfig: BotConfig = { ...freshConfig, sumTarget: 0.98 };
      const looseStrategy = new HedgeStrategy(looseConfig);

      // sum = 0.96
      expect(defaultStrategy.shouldHedge(0.5, 0.46)).toBe(false); // 0.96 > 0.95
      expect(looseStrategy.shouldHedge(0.5, 0.46)).toBe(true); // 0.96 <= 0.98
    });
  });

  describe('predictHedgeProbability() - 对冲概率预判', () => {
    // 创建测试用价格快照
    function createPriceSnapshot(
      timestamp: number,
      upAsk: number,
      downAsk: number,
      upBid?: number,
      downBid?: number
    ): PriceSnapshot {
      return {
        timestamp,
        roundSlug: 'test-round',
        secondsRemaining: 600,
        upTokenId: 'up-token',
        downTokenId: 'down-token',
        upBestAsk: upAsk,
        upBestBid: upBid ?? upAsk - 0.01,
        downBestAsk: downAsk,
        downBestBid: downBid ?? downAsk - 0.01,
      };
    }

    it('数据不足时应该返回低置信度结果', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      // 只添加少量数据
      buffer.push(createPriceSnapshot(Date.now(), 0.5, 0.5));
      buffer.push(createPriceSnapshot(Date.now() + 100, 0.5, 0.5));

      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      expect(result.confidence).toBeLessThan(0.3);
      expect(result.recommendation).toBe('wait');
      expect(result.reason).toContain('数据不足');
    });

    it('已满足对冲条件时应该建议进入', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      // 添加足够的价格数据，对方价格已经低于目标
      for (let i = 0; i < 20; i++) {
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, 0.5)); // DOWN @ 0.5
      }

      // Leg1 @ 0.4, maxLeg2 = 0.55, 当前 DOWN @ 0.5 <= 0.55
      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      expect(result.probability).toBeGreaterThan(0.8);
      expect(result.recommendation).toBe('enter');
    });

    it('价格差距大且波动率低时应该建议跳过', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      // 添加稳定的高价格数据 (无波动)
      for (let i = 0; i < 20; i++) {
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, 0.65)); // DOWN @ 0.65
      }

      // Leg1 @ 0.4, maxLeg2 = 0.55, 当前 DOWN @ 0.65 远超目标
      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      expect(result.probability).toBeLessThan(0.5);
      expect(result.factors.priceVolatility).toBeLessThan(0.01);
    });

    it('时间不足时应该建议跳过', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      for (let i = 0; i < 20; i++) {
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, 0.6));
      }

      // 只剩 30 秒
      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 30);

      expect(result.recommendation).toBe('skip');
      expect(result.reason).toContain('时间');
    });

    it('应该正确计算波动率因子', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      // 添加波动的价格数据
      for (let i = 0; i < 20; i++) {
        const volatilePrice = 0.55 + (i % 2 === 0 ? 0.02 : -0.02); // 在 0.53 和 0.57 之间波动
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, volatilePrice));
      }

      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      expect(result.factors.priceVolatility).toBeGreaterThan(0);
    });

    it('应该正确计算趋势因子', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      // 添加下跌趋势的价格数据
      for (let i = 0; i < 20; i++) {
        const decliningPrice = 0.6 - i * 0.005; // 从 0.6 下跌到 0.505
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, decliningPrice));
      }

      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      // 下跌趋势 (负值) 有利于对冲
      expect(result.factors.trendDirection).toBeLessThan(0);
    });

    it('应该返回完整的预判结果结构', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      for (let i = 0; i < 20; i++) {
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, 0.55));
      }

      const result = strategy.predictHedgeProbability('UP', 0.4, buffer, 600);

      // 验证返回结构
      expect(result).toHaveProperty('probability');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('expectedTimeToHedge');
      expect(result).toHaveProperty('recommendation');
      expect(result).toHaveProperty('factors');
      expect(result).toHaveProperty('reason');

      // 验证因子结构
      expect(result.factors).toHaveProperty('priceVolatility');
      expect(result.factors).toHaveProperty('trendDirection');
      expect(result.factors).toHaveProperty('spreadHealth');
      expect(result.factors).toHaveProperty('timeRemaining');

      // 验证值范围
      expect(result.probability).toBeGreaterThanOrEqual(0);
      expect(result.probability).toBeLessThanOrEqual(1);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(['enter', 'wait', 'skip']).toContain(result.recommendation);
    });

    it('DOWN 方向的预判应该分析 UP 价格', () => {
      const buffer = new CircularBuffer<PriceSnapshot>(100);
      const now = Date.now();

      // UP 价格低 (有利于 DOWN 方向对冲)
      for (let i = 0; i < 20; i++) {
        buffer.push(createPriceSnapshot(now - (20 - i) * 1000, 0.5, 0.6)); // UP @ 0.5
      }

      // Leg1 买 DOWN @ 0.4, maxLeg2 (UP) = 0.55, 当前 UP @ 0.5 <= 0.55
      const result = strategy.predictHedgeProbability('DOWN', 0.4, buffer, 600);

      expect(result.probability).toBeGreaterThan(0.7);
    });
  });
});
