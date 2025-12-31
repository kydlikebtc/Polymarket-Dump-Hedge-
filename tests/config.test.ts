/**
 * 配置模块单元测试
 *
 * 测试环境变量加载和边界检查功能 (SEC-009)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('配置模块', () => {
  // 保存原始环境变量
  const originalEnv = process.env;

  beforeEach(() => {
    // 重置模块缓存以重新加载配置
    vi.resetModules();
    // 创建干净的环境变量副本
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // 恢复原始环境变量
    process.env = originalEnv;
  });

  describe('SEC-009: 环境变量边界检查', () => {
    describe('DEFAULT_SHARES', () => {
      it('应该接受有效值 (1-10000)', async () => {
        process.env.DEFAULT_SHARES = '100';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.shares).toBe(100);
      });

      it('应该拒绝低于最小值的值', async () => {
        process.env.DEFAULT_SHARES = '0';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('below minimum');
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.DEFAULT_SHARES = '10001';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('SUM_TARGET', () => {
      it('应该接受有效值 (0.5-1.0)', async () => {
        process.env.SUM_TARGET = '0.95';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.sumTarget).toBe(0.95);
      });

      it('应该拒绝低于最小值的值', async () => {
        process.env.SUM_TARGET = '0.4';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('below minimum');
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.SUM_TARGET = '1.1';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('MOVE_PCT', () => {
      it('应该接受有效值 (0.01-0.50)', async () => {
        process.env.MOVE_PCT = '0.15';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.movePct).toBe(0.15);
      });

      it('应该拒绝低于最小值的值', async () => {
        process.env.MOVE_PCT = '0.005';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('below minimum');
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.MOVE_PCT = '0.6';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('WINDOW_MIN', () => {
      it('应该接受有效值 (1-15)', async () => {
        process.env.WINDOW_MIN = '5';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.windowMin).toBe(5);
      });

      it('应该拒绝低于最小值的值', async () => {
        process.env.WINDOW_MIN = '0';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('below minimum');
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.WINDOW_MIN = '20';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('RECONNECT_DELAY', () => {
      it('应该接受有效值 (100-60000)', async () => {
        process.env.RECONNECT_DELAY = '1000';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.reconnectDelay).toBe(1000);
      });

      it('应该拒绝低于最小值的值', async () => {
        process.env.RECONNECT_DELAY = '50';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('below minimum');
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.RECONNECT_DELAY = '100000';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('MAX_RECONNECTS', () => {
      it('应该接受有效值 (0-100)', async () => {
        process.env.MAX_RECONNECTS = '5';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.maxReconnects).toBe(5);
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.MAX_RECONNECTS = '200';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('FEE_RATE', () => {
      it('应该接受有效值 (0-0.10)', async () => {
        process.env.FEE_RATE = '0.005';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.feeRate).toBe(0.005);
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.FEE_RATE = '0.15';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('SPREAD_BUFFER', () => {
      it('应该接受有效值 (0-0.20)', async () => {
        process.env.SPREAD_BUFFER = '0.02';
        const { loadConfig } = await import('../src/utils/config.js');
        const config = loadConfig();
        expect(config.spreadBuffer).toBe(0.02);
      });

      it('应该拒绝超过最大值的值', async () => {
        process.env.SPREAD_BUFFER = '0.30';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('exceeds maximum');
      });
    });

    describe('无效数字格式', () => {
      it('应该拒绝非数字字符串', async () => {
        process.env.DEFAULT_SHARES = 'abc';
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('Invalid number');
      });

      it('应该拒绝空字符串', async () => {
        process.env.DEFAULT_SHARES = '';
        // 空字符串会被 parseFloat 解析为 NaN
        const { loadConfig } = await import('../src/utils/config.js');
        expect(() => loadConfig()).toThrow('Invalid number');
      });
    });
  });

  describe('默认值', () => {
    it('应该使用默认配置值', async () => {
      // 清除所有相关环境变量
      delete process.env.DEFAULT_SHARES;
      delete process.env.SUM_TARGET;
      delete process.env.MOVE_PCT;
      delete process.env.WINDOW_MIN;
      delete process.env.RECONNECT_DELAY;
      delete process.env.MAX_RECONNECTS;
      delete process.env.FEE_RATE;
      delete process.env.SPREAD_BUFFER;

      const { loadConfig } = await import('../src/utils/config.js');
      const config = loadConfig();

      expect(config.shares).toBe(20);
      expect(config.sumTarget).toBe(0.95);
      expect(config.movePct).toBe(0.15);
      expect(config.windowMin).toBe(2);
      expect(config.reconnectDelay).toBe(1000);
      expect(config.maxReconnects).toBe(5);
      expect(config.feeRate).toBe(0.005);
      expect(config.spreadBuffer).toBe(0.02);
    });
  });

  describe('updateConfigParam', () => {
    it('应该更新配置参数', async () => {
      const { loadConfig, updateConfigParam } = await import('../src/utils/config.js');
      const config = loadConfig();

      const updatedConfig = updateConfigParam(config, 'shares', 50);

      expect(updatedConfig.shares).toBe(50);
      expect(config.shares).toBe(20); // 原配置不变
    });

    it('应该验证更新后的配置', async () => {
      const { loadConfig, updateConfigParam } = await import('../src/utils/config.js');
      const config = loadConfig();

      // movePct 最大值在 validateConfig 中是 0.30
      expect(() => updateConfigParam(config, 'movePct', 0.5)).toThrow('movePct must be between');
    });
  });
});
