/**
 * StateMachine 单元测试
 *
 * 注意：StateMachine 的设计是基于完整的交易周期管理，
 * 必须先调用 startNewCycle() 才能进行状态转换
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateMachine } from '../src/core/StateMachine.js';
import { CycleStatus } from '../src/types/index.js';

describe('StateMachine', () => {
  let fsm: StateMachine;

  beforeEach(() => {
    fsm = new StateMachine();
  });

  describe('初始状态', () => {
    it('应该初始化为 IDLE 状态（无活跃周期）', () => {
      expect(fsm.getCurrentStatus()).toBe('IDLE');
      expect(fsm.getCurrentCycle()).toBeNull();
    });
  });

  describe('交易周期启动', () => {
    it('startNewCycle 应该创建新周期并自动进入 WATCHING 状态', () => {
      const cycle = fsm.startNewCycle('BTC-15min-2024-01-01');

      expect(cycle).not.toBeNull();
      expect(cycle.id).toBeTruthy();
      expect(cycle.roundSlug).toBe('BTC-15min-2024-01-01');
      expect(fsm.getCurrentStatus()).toBe('WATCHING');
    });

    it('应该保存当前周期引用', () => {
      fsm.startNewCycle('test-round');

      const currentCycle = fsm.getCurrentCycle();
      expect(currentCycle).not.toBeNull();
      expect(currentCycle?.status).toBe('WATCHING');
    });
  });

  describe('状态转换', () => {
    beforeEach(() => {
      fsm.startNewCycle('test-round');
    });

    it('WATCHING → LEG1_PENDING 应该成功', () => {
      const result = fsm.transition('LEG1_PENDING', 'dump_detected');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('LEG1_PENDING');
    });

    it('LEG1_PENDING → LEG1_FILLED 应该成功', () => {
      fsm.transition('LEG1_PENDING', 'dump_detected');
      const result = fsm.transition('LEG1_FILLED', 'order_filled');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('LEG1_FILLED');
    });

    it('LEG1_FILLED → LEG2_PENDING 应该成功', () => {
      fsm.transition('LEG1_PENDING', 'dump_detected');
      fsm.transition('LEG1_FILLED', 'order_filled');
      const result = fsm.transition('LEG2_PENDING', 'hedge_started');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('LEG2_PENDING');
    });

    it('LEG2_PENDING → COMPLETED 应该成功', () => {
      fsm.transition('LEG1_PENDING', 'dump_detected');
      fsm.transition('LEG1_FILLED', 'order_filled');
      fsm.transition('LEG2_PENDING', 'hedge_started');
      const result = fsm.transition('COMPLETED', 'hedge_filled');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('COMPLETED');
    });

    it('完整交易周期流程', () => {
      expect(fsm.getCurrentStatus()).toBe('WATCHING');
      expect(fsm.transition('LEG1_PENDING', 'dump_detected')).toBe(true);
      expect(fsm.transition('LEG1_FILLED', 'order_filled')).toBe(true);
      expect(fsm.transition('LEG2_PENDING', 'hedge_started')).toBe(true);
      expect(fsm.transition('COMPLETED', 'hedge_filled')).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('COMPLETED');
    });
  });

  describe('无效转换', () => {
    beforeEach(() => {
      fsm.startNewCycle('test-round');
    });

    it('WATCHING → COMPLETED 应该失败', () => {
      const result = fsm.transition('COMPLETED', 'invalid');
      expect(result).toBe(false);
      expect(fsm.getCurrentStatus()).toBe('WATCHING');
    });

    it('WATCHING → LEG1_FILLED 应该失败（跳过 LEG1_PENDING）', () => {
      const result = fsm.transition('LEG1_FILLED', 'invalid');
      expect(result).toBe(false);
      expect(fsm.getCurrentStatus()).toBe('WATCHING');
    });

    it('LEG1_PENDING → COMPLETED 应该失败', () => {
      fsm.transition('LEG1_PENDING', 'dump_detected');
      const result = fsm.transition('COMPLETED', 'invalid');
      expect(result).toBe(false);
      expect(fsm.getCurrentStatus()).toBe('LEG1_PENDING');
    });
  });

  describe('错误和过期状态', () => {
    beforeEach(() => {
      fsm.startNewCycle('test-round');
    });

    it('WATCHING → ERROR 应该成功', () => {
      const result = fsm.transition('ERROR', 'error_occurred');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('ERROR');
    });

    it('LEG1_FILLED → ROUND_EXPIRED 应该成功', () => {
      fsm.transition('LEG1_PENDING', 'dump_detected');
      fsm.transition('LEG1_FILLED', 'order_filled');
      const result = fsm.transition('ROUND_EXPIRED', 'round_expired');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('ROUND_EXPIRED');
    });

    it('ERROR → IDLE 应该成功 (重置)', () => {
      fsm.transition('ERROR', 'error_occurred');
      const result = fsm.transition('IDLE', 'reset');
      expect(result).toBe(true);
      expect(fsm.getCurrentStatus()).toBe('IDLE');
    });
  });

  describe('重置功能', () => {
    it('reset() 应该在终止状态后清除周期', () => {
      fsm.startNewCycle('test-round');
      fsm.transition('LEG1_PENDING', 'dump_detected');
      fsm.transition('LEG1_FILLED', 'order_filled');
      fsm.transition('LEG2_PENDING', 'hedge_started');
      fsm.transition('COMPLETED', 'hedge_filled');

      expect(fsm.getCurrentStatus()).toBe('COMPLETED');

      fsm.reset();
      expect(fsm.getCurrentCycle()).toBeNull();
      expect(fsm.getCurrentStatus()).toBe('IDLE');
    });
  });

  describe('活跃状态检查', () => {
    it('isActive() 应该在 WATCHING 状态返回 true', () => {
      expect(fsm.isActive()).toBe(false);

      fsm.startNewCycle('test-round');
      expect(fsm.isActive()).toBe(true);

      fsm.transition('LEG1_PENDING', 'dump_detected');
      expect(fsm.isActive()).toBe(false);
    });

    it('isWaitingForHedge() 应该在 LEG1_FILLED 状态返回 true', () => {
      fsm.startNewCycle('test-round');
      expect(fsm.isWaitingForHedge()).toBe(false);

      fsm.transition('LEG1_PENDING', 'dump_detected');
      expect(fsm.isWaitingForHedge()).toBe(false);

      fsm.transition('LEG1_FILLED', 'order_filled');
      expect(fsm.isWaitingForHedge()).toBe(true);
    });
  });

  describe('转换历史', () => {
    it('应该记录所有状态转换', () => {
      fsm.startNewCycle('test-round');
      fsm.transition('LEG1_PENDING', 'dump_detected');
      fsm.transition('LEG1_FILLED', 'order_filled');

      const history = fsm.getTransitionHistory();
      expect(history.length).toBe(3); // IDLE→WATCHING, WATCHING→LEG1_PENDING, LEG1_PENDING→LEG1_FILLED

      expect(history[0].from).toBe('IDLE');
      expect(history[0].to).toBe('WATCHING');
      expect(history[1].from).toBe('WATCHING');
      expect(history[1].to).toBe('LEG1_PENDING');
      expect(history[2].from).toBe('LEG1_PENDING');
      expect(history[2].to).toBe('LEG1_FILLED');
    });
  });

  describe('超时机制', () => {
    describe('超时配置', () => {
      it('应该使用默认超时配置', () => {
        const config = fsm.getTimeoutConfig();
        expect(config.leg1PendingTimeout).toBe(30 * 1000);
        expect(config.leg1FilledTimeout).toBe(120 * 1000);
        expect(config.leg2PendingTimeout).toBe(30 * 1000);
      });

      it('应该支持自定义超时配置', () => {
        const customFsm = new StateMachine({
          leg1PendingTimeout: 10000,
          leg1FilledTimeout: 60000,
          leg2PendingTimeout: 15000,
        });
        const config = customFsm.getTimeoutConfig();
        expect(config.leg1PendingTimeout).toBe(10000);
        expect(config.leg1FilledTimeout).toBe(60000);
        expect(config.leg2PendingTimeout).toBe(15000);
      });

      it('应该支持部分自定义配置', () => {
        const customFsm = new StateMachine({
          leg1PendingTimeout: 5000,
        });
        const config = customFsm.getTimeoutConfig();
        expect(config.leg1PendingTimeout).toBe(5000);
        expect(config.leg1FilledTimeout).toBe(120 * 1000); // 默认值
        expect(config.leg2PendingTimeout).toBe(30 * 1000); // 默认值
      });

      it('应该能够更新超时配置', () => {
        fsm.updateTimeoutConfig({ leg1PendingTimeout: 20000 });
        const config = fsm.getTimeoutConfig();
        expect(config.leg1PendingTimeout).toBe(20000);
        expect(config.leg1FilledTimeout).toBe(120 * 1000); // 未修改
      });
    });

    describe('checkTimeout()', () => {
      it('无活跃周期时应返回无超时', () => {
        const result = fsm.checkTimeout();
        expect(result.isTimeout).toBe(false);
        expect(result.status).toBeNull();
        expect(result.action).toBe('none');
      });

      it('WATCHING 状态不检查超时', () => {
        fsm.startNewCycle('test-round');
        const result = fsm.checkTimeout();
        expect(result.isTimeout).toBe(false);
        expect(result.action).toBe('none');
      });

      it('LEG1_PENDING 超时应返回 cancel 动作', async () => {
        const shortTimeoutFsm = new StateMachine({ leg1PendingTimeout: 50 });
        shortTimeoutFsm.startNewCycle('test-round');
        shortTimeoutFsm.transition('LEG1_PENDING', 'dump_detected');

        // 等待超时
        await new Promise(resolve => setTimeout(resolve, 100));

        const result = shortTimeoutFsm.checkTimeout();
        expect(result.isTimeout).toBe(true);
        expect(result.status).toBe('LEG1_PENDING');
        expect(result.action).toBe('cancel');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(50);
      });

      it('LEG1_FILLED 超时应返回 warn 动作', async () => {
        const shortTimeoutFsm = new StateMachine({ leg1FilledTimeout: 50 });
        shortTimeoutFsm.startNewCycle('test-round');
        shortTimeoutFsm.transition('LEG1_PENDING', 'dump_detected');
        shortTimeoutFsm.transition('LEG1_FILLED', 'order_filled');

        // 等待超时
        await new Promise(resolve => setTimeout(resolve, 100));

        const result = shortTimeoutFsm.checkTimeout();
        expect(result.isTimeout).toBe(true);
        expect(result.status).toBe('LEG1_FILLED');
        expect(result.action).toBe('warn');
      });

      it('LEG2_PENDING 超时应返回 cancel 动作', async () => {
        const shortTimeoutFsm = new StateMachine({ leg2PendingTimeout: 50 });
        shortTimeoutFsm.startNewCycle('test-round');
        shortTimeoutFsm.transition('LEG1_PENDING', 'dump_detected');
        shortTimeoutFsm.transition('LEG1_FILLED', 'order_filled');
        shortTimeoutFsm.transition('LEG2_PENDING', 'hedge_started');

        // 等待超时
        await new Promise(resolve => setTimeout(resolve, 100));

        const result = shortTimeoutFsm.checkTimeout();
        expect(result.isTimeout).toBe(true);
        expect(result.status).toBe('LEG2_PENDING');
        expect(result.action).toBe('cancel');
      });

      it('未超时时应返回 none 动作', () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');

        const result = fsm.checkTimeout();
        expect(result.isTimeout).toBe(false);
        expect(result.action).toBe('none');
      });
    });

    describe('getLeg1UnhedgedDuration()', () => {
      it('无活跃周期时应返回 0', () => {
        expect(fsm.getLeg1UnhedgedDuration()).toBe(0);
      });

      it('非 LEG1_FILLED 状态应返回 0', () => {
        fsm.startNewCycle('test-round');
        expect(fsm.getLeg1UnhedgedDuration()).toBe(0);

        fsm.transition('LEG1_PENDING', 'dump_detected');
        expect(fsm.getLeg1UnhedgedDuration()).toBe(0);
      });

      it('LEG1_FILLED 状态应返回正确的持续时间', async () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');

        // 模拟 Leg1 成交
        fsm.onLeg1Filled({
          orderId: 'test-order',
          side: 'UP',
          shares: 100,
          avgPrice: 0.4,
          totalCost: 40,
          timestamp: Date.now(),
        });

        expect(fsm.getCurrentStatus()).toBe('LEG1_FILLED');

        // 等待一小段时间
        await new Promise(resolve => setTimeout(resolve, 50));

        const duration = fsm.getLeg1UnhedgedDuration();
        expect(duration).toBeGreaterThanOrEqual(50);
        expect(duration).toBeLessThan(200); // 合理范围内
      });
    });

    describe('shouldForceExpire()', () => {
      it('无活跃周期时应返回 false', () => {
        expect(fsm.shouldForceExpire(100)).toBe(false);
      });

      it('WATCHING 状态不应强制过期', () => {
        fsm.startNewCycle('test-round');
        expect(fsm.shouldForceExpire(5)).toBe(false);
      });

      it('LEG1_FILLED 状态且剩余时间 < 10 秒应强制过期', () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');
        fsm.transition('LEG1_FILLED', 'order_filled');

        expect(fsm.shouldForceExpire(9)).toBe(true);
        expect(fsm.shouldForceExpire(10)).toBe(false);
        expect(fsm.shouldForceExpire(100)).toBe(false);
      });

      it('LEG1_PENDING 状态且剩余时间 < 5 秒应强制过期', () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');

        expect(fsm.shouldForceExpire(4)).toBe(true);
        expect(fsm.shouldForceExpire(5)).toBe(false);
        expect(fsm.shouldForceExpire(100)).toBe(false);
      });

      it('LEG2_PENDING 状态且剩余时间 < 5 秒应强制过期', () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');
        fsm.transition('LEG1_FILLED', 'order_filled');
        fsm.transition('LEG2_PENDING', 'hedge_started');

        expect(fsm.shouldForceExpire(4)).toBe(true);
        expect(fsm.shouldForceExpire(5)).toBe(false);
      });

      it('COMPLETED 状态不应强制过期', () => {
        fsm.startNewCycle('test-round');
        fsm.transition('LEG1_PENDING', 'dump_detected');
        fsm.transition('LEG1_FILLED', 'order_filled');
        fsm.transition('LEG2_PENDING', 'hedge_started');
        fsm.transition('COMPLETED', 'hedge_filled');

        expect(fsm.shouldForceExpire(1)).toBe(false);
      });
    });
  });
});
