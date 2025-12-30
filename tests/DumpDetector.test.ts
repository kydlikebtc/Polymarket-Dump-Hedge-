/**
 * DumpDetector 单元测试
 *
 * 注意：DumpDetector 的设计需要传入完整的 BotConfig 和 CircularBuffer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DumpDetector } from '../src/core/DumpDetector.js';
import { CircularBuffer } from '../src/utils/CircularBuffer.js';
import { BotConfig, PriceSnapshot } from '../src/types/index.js';

describe('DumpDetector', () => {
  let detector: DumpDetector;
  let priceBuffer: CircularBuffer<PriceSnapshot>;

  // 测试配置
  const testConfig: BotConfig = {
    tokenIdUp: 'test-up',
    tokenIdDown: 'test-down',
    conditionId: 'test-condition',
    wsUrl: 'wss://test.com',
    apiUrl: 'https://test.com',
    privateKey: '',
    movePct: 0.15, // 15% 跌幅阈值
    windowMin: 10, // 10 分钟监控窗口
    sumTarget: 0.95,
    shares: 100,
    feeRate: 0.002,
    dryRun: true,
    dbPath: ':memory:',
  };

  /**
   * 创建价格快照
   */
  function createSnapshot(
    upPrice: number,
    downPrice: number,
    timestamp: number = Date.now()
  ): PriceSnapshot {
    return {
      timestamp,
      upBestBid: upPrice - 0.01,
      upBestAsk: upPrice,
      downBestBid: downPrice - 0.01,
      downBestAsk: downPrice,
    };
  }

  beforeEach(() => {
    detector = new DumpDetector(testConfig);
    priceBuffer = new CircularBuffer<PriceSnapshot>(1000);

    // 设置回合开始时间
    detector.setRoundStartTime(Date.now());
  });

  describe('初始化', () => {
    it('应该正确初始化检测器', () => {
      const config = detector.getConfig();
      expect(config.movePct).toBe(0.15);
      expect(config.windowMin).toBe(10);
    });
  });

  describe('Side 锁定', () => {
    it('锁定后 isLocked() 应返回 true', () => {
      expect(detector.isLocked()).toBe(false);
      detector.lockSide('UP');
      expect(detector.isLocked()).toBe(true);
      expect(detector.getLockedSide()).toBe('UP');
    });

    it('unlock() 应该解锁', () => {
      detector.lockSide('DOWN');
      detector.unlock();
      expect(detector.isLocked()).toBe(false);
      expect(detector.getLockedSide()).toBeNull();
    });
  });

  describe('暴跌检测', () => {
    it('应该检测 UP 侧暴跌', () => {
      const now = Date.now();

      // 添加价格序列：UP 从 0.6 跌到 0.5 (-16.7%)
      priceBuffer.push(createSnapshot(0.6, 0.4, now - 2500));
      priceBuffer.push(createSnapshot(0.55, 0.45, now - 1500));
      priceBuffer.push(createSnapshot(0.5, 0.5, now));

      const signal = detector.detect(priceBuffer, 'test-round');

      expect(signal).not.toBeNull();
      expect(signal!.side).toBe('UP');
    });

    it('应该检测 DOWN 侧暴跌', () => {
      const now = Date.now();

      // 添加价格序列：DOWN 从 0.7 跌到 0.58 (-17.1%)
      priceBuffer.push(createSnapshot(0.3, 0.7, now - 2500));
      priceBuffer.push(createSnapshot(0.35, 0.65, now - 1500));
      priceBuffer.push(createSnapshot(0.42, 0.58, now));

      const signal = detector.detect(priceBuffer, 'test-round');

      expect(signal).not.toBeNull();
      expect(signal!.side).toBe('DOWN');
    });

    it('小幅波动不应该触发', () => {
      const now = Date.now();

      // 小幅波动
      priceBuffer.push(createSnapshot(0.5, 0.5, now - 2500));
      priceBuffer.push(createSnapshot(0.51, 0.49, now - 1500));
      priceBuffer.push(createSnapshot(0.49, 0.51, now));

      const signal = detector.detect(priceBuffer, 'test-round');
      expect(signal).toBeNull();
    });

    it('锁定方向后不应检测该方向', () => {
      detector.lockSide('UP');
      const now = Date.now();

      // UP 暴跌
      priceBuffer.push(createSnapshot(0.7, 0.3, now - 2000));
      priceBuffer.push(createSnapshot(0.58, 0.42, now));

      const signal = detector.detect(priceBuffer, 'test-round');
      expect(signal).toBeNull();
    });
  });

  describe('监控窗口', () => {
    it('未设置回合时间时不应检测', () => {
      const freshDetector = new DumpDetector(testConfig);
      const now = Date.now();

      priceBuffer.push(createSnapshot(0.7, 0.3, now - 2000));
      priceBuffer.push(createSnapshot(0.5, 0.5, now));

      const signal = freshDetector.detect(priceBuffer, 'test-round');
      expect(signal).toBeNull();
    });

    it('getRemainingWindowTime() 应该返回剩余时间', () => {
      const remaining = detector.getRemainingWindowTime();
      // 刚设置回合开始时间，应该接近 10 分钟
      expect(remaining).toBeGreaterThan(500);
      expect(remaining).toBeLessThanOrEqual(600);
    });
  });

  describe('配置更新', () => {
    it('应该允许更新 movePct', () => {
      detector.updateConfig(0.20, undefined);
      expect(detector.getConfig().movePct).toBe(0.20);
    });

    it('应该允许更新 windowMin', () => {
      detector.updateConfig(undefined, 5);
      expect(detector.getConfig().windowMin).toBe(5);
    });

    it('无效的 movePct 应该抛出错误', () => {
      expect(() => detector.updateConfig(0.005)).toThrow();
      expect(() => detector.updateConfig(0.5)).toThrow();
    });

    it('无效的 windowMin 应该抛出错误', () => {
      expect(() => detector.updateConfig(undefined, 0)).toThrow();
      expect(() => detector.updateConfig(undefined, 20)).toThrow();
    });
  });
});
