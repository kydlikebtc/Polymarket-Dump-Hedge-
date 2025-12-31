/**
 * AlertManager 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertManager, initAlertManager, getAlertManager } from '../src/utils/AlertManager.js';
import type { Alert, TradeCycle, DumpSignal } from '../src/types/index.js';

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch for Telegram/Discord
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AlertManager', () => {
  let alertManager: AlertManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    alertManager = new AlertManager({
      channels: { console: true },
      minSeverity: 'info',
      throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
    });
  });

  describe('基本告警功能', () => {
    it('应该发送 info 级别告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'info',
        title: '测试告警',
        message: '这是一条测试消息',
        timestamp: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('测试告警');
      expect(output).toContain('这是一条测试消息');

      consoleSpy.mockRestore();
    });

    it('应该发送 warning 级别告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'warning',
        title: '警告测试',
        message: '这是一条警告',
        timestamp: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('⚠️');
      expect(output).toContain('WARNING');

      consoleSpy.mockRestore();
    });

    it('应该发送 critical 级别告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'critical',
        title: '严重告警',
        message: '这是一条严重告警',
        timestamp: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('🚨');
      expect(output).toContain('CRITICAL');

      consoleSpy.mockRestore();
    });

    it('应该在告警中包含数据', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'info',
        title: '带数据的告警',
        message: '测试',
        timestamp: Date.now(),
        data: { key: 'value', number: 123 },
      });

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('key');
      expect(output).toContain('value');

      consoleSpy.mockRestore();
    });
  });

  describe('告警级别过滤', () => {
    it('应该过滤低于最小级别的告警', async () => {
      const manager = new AlertManager({
        channels: { console: true },
        minSeverity: 'warning',
        throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // info 级别应该被过滤
      await manager.send({
        severity: 'info',
        title: '应该被过滤',
        message: '测试',
        timestamp: Date.now(),
      });

      expect(consoleSpy).not.toHaveBeenCalled();

      // warning 级别应该通过
      await manager.send({
        severity: 'warning',
        title: '应该通过',
        message: '测试',
        timestamp: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('告警节流', () => {
    it('应该在超过限制后节流告警', async () => {
      const manager = new AlertManager({
        channels: { console: true },
        minSeverity: 'info',
        throttle: { enabled: true, windowMs: 60000, maxPerWindow: 3 },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // 前3个应该通过
      for (let i = 0; i < 3; i++) {
        await manager.send({
          severity: 'info',
          title: `告警 ${i + 1}`,
          message: '测试',
          timestamp: Date.now(),
        });
      }

      expect(consoleSpy).toHaveBeenCalledTimes(3);

      // 第4个应该被节流
      await manager.send({
        severity: 'info',
        title: '应该被节流',
        message: '测试',
        timestamp: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalledTimes(3);

      consoleSpy.mockRestore();
    });
  });

  describe('预定义告警方法', () => {
    it('应该发送交易完成告警 (盈利)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const cycle: TradeCycle = {
        id: 'test-cycle',
        roundSlug: 'test-round',
        status: 'COMPLETED',
        leg1: {
          orderId: 'order1',
          side: 'DOWN',
          shares: 20,
          entryPrice: 0.35,
          totalCost: 7,
          filledAt: Date.now(),
        },
        leg2: {
          orderId: 'order2',
          side: 'UP',
          shares: 20,
          entryPrice: 0.58,
          totalCost: 11.6,
          filledAt: Date.now(),
        },
        profit: 1.4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await alertManager.alertTradeCompleted(cycle, 1.4);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('交易完成');
      expect(output).toContain('+$1.40');

      consoleSpy.mockRestore();
    });

    it('应该发送交易完成告警 (亏损)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const cycle: TradeCycle = {
        id: 'test-cycle',
        roundSlug: 'test-round',
        status: 'COMPLETED',
        leg1: {
          orderId: 'order1',
          side: 'DOWN',
          shares: 20,
          entryPrice: 0.50,
          totalCost: 10,
          filledAt: Date.now(),
        },
        leg2: {
          orderId: 'order2',
          side: 'UP',
          shares: 20,
          entryPrice: 0.55,
          totalCost: 11,
          filledAt: Date.now(),
        },
        profit: -1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await alertManager.alertTradeCompleted(cycle, -1.0);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('WARNING'); // 亏损应该是 warning
      expect(output).toContain('-$1.00');

      consoleSpy.mockRestore();
    });

    it('应该发送暴跌检测告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const signal: DumpSignal = {
        side: 'UP',
        dropPct: 0.18,
        price: 0.41,
        previousPrice: 0.50,
        timestamp: Date.now(),
        roundSlug: 'test-round',
      };

      await alertManager.alertDumpDetected(signal);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('暴跌信号检测');
      expect(output).toContain('UP');
      expect(output).toContain('18.00%');

      consoleSpy.mockRestore();
    });

    it('应该发送订单失败告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.alertOrderFailed('DOWN', 'Insufficient balance');

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('CRITICAL');
      expect(output).toContain('订单执行失败');
      expect(output).toContain('Insufficient balance');

      consoleSpy.mockRestore();
    });

    it('应该发送 WebSocket 断开告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.alertWebSocketDisconnected(1006, 'Connection reset');

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('WARNING');
      expect(output).toContain('WebSocket 断开');
      expect(output).toContain('1006');

      consoleSpy.mockRestore();
    });

    it('应该发送资金不足告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.alertInsufficientFunds(100, 50);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('CRITICAL');
      expect(output).toContain('资金不足');
      expect(output).toContain('$100.00');
      expect(output).toContain('$50.00');

      consoleSpy.mockRestore();
    });

    it('应该发送轮次过期告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const cycle: TradeCycle = {
        id: 'test-cycle',
        roundSlug: 'test-round',
        status: 'ROUND_EXPIRED',
        leg1: {
          orderId: 'order1',
          side: 'DOWN',
          shares: 20,
          entryPrice: 0.35,
          totalCost: 7,
          filledAt: Date.now(),
        },
        profit: -7,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await alertManager.alertRoundExpiredWithLoss(cycle, -7);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('CRITICAL');
      expect(output).toContain('轮次过期');
      expect(output).toContain('$7.00');

      consoleSpy.mockRestore();
    });

    it('应该发送系统错误告警', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const error = new Error('Test system error');
      await alertManager.alertSystemError(error);

      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('CRITICAL');
      expect(output).toContain('系统错误');
      expect(output).toContain('Test system error');

      consoleSpy.mockRestore();
    });
  });

  describe('Telegram 集成', () => {
    it('应该发送告警到 Telegram', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      const manager = new AlertManager({
        channels: {
          console: false,
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
            chatId: '123456789',
          },
        },
        minSeverity: 'info',
        throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
      });

      await manager.send({
        severity: 'info',
        title: 'Telegram 测试',
        message: '测试消息',
        timestamp: Date.now(),
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-bot-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('123456789');
      expect(body.text).toContain('Telegram 测试');
    });

    it('应该处理 Telegram API 错误', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      const manager = new AlertManager({
        channels: {
          console: false,
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
            chatId: '123456789',
          },
        },
        minSeverity: 'info',
        throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
      });

      // 不应该抛出错误
      await expect(manager.send({
        severity: 'info',
        title: '测试',
        message: '测试',
        timestamp: Date.now(),
      })).resolves.not.toThrow();
    });
  });

  describe('Discord 集成', () => {
    it('应该发送告警到 Discord', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      const manager = new AlertManager({
        channels: {
          console: false,
          discord: {
            enabled: true,
            webhookUrl: 'https://discord.com/api/webhooks/123/abc',
          },
        },
        minSeverity: 'info',
        throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
      });

      await manager.send({
        severity: 'warning',
        title: 'Discord 测试',
        message: '测试消息',
        timestamp: Date.now(),
        data: { key: 'value' },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.username).toBe('PM Dump & Hedge Bot');
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe('Discord 测试');
      expect(body.embeds[0].color).toBe(0xf39c12); // Orange for warning
    });
  });

  describe('告警历史', () => {
    it('应该记录告警历史', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'info',
        title: '历史测试 1',
        message: '测试',
        timestamp: Date.now(),
      });

      await alertManager.send({
        severity: 'warning',
        title: '历史测试 2',
        message: '测试',
        timestamp: Date.now(),
      });

      const history = alertManager.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].title).toBe('历史测试 1');
      expect(history[1].title).toBe('历史测试 2');
    });

    it('应该限制历史记录数量', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // 发送超过100条
      for (let i = 0; i < 110; i++) {
        await alertManager.send({
          severity: 'info',
          title: `告警 ${i}`,
          message: '测试',
          timestamp: Date.now(),
        });
      }

      const history = alertManager.getHistory();
      expect(history).toHaveLength(100);
      expect(history[0].title).toBe('告警 10'); // 前10条被移除
    });

    it('应该能清除历史', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await alertManager.send({
        severity: 'info',
        title: '测试',
        message: '测试',
        timestamp: Date.now(),
      });

      alertManager.clearHistory();
      expect(alertManager.getHistory()).toHaveLength(0);
    });
  });

  describe('配置更新', () => {
    it('应该能更新配置', () => {
      alertManager.updateConfig({
        minSeverity: 'critical',
      });

      // 验证配置已更新（通过发送低级别告警来验证）
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      alertManager.send({
        severity: 'warning',
        title: '应该被过滤',
        message: '测试',
        timestamp: Date.now(),
      });

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('单例模式', () => {
    it('getAlertManager 应该返回单例', () => {
      const manager1 = getAlertManager();
      const manager2 = getAlertManager();
      expect(manager1).toBe(manager2);
    });

    it('initAlertManager 应该创建新实例', () => {
      const manager1 = getAlertManager();
      const manager2 = initAlertManager({
        channels: { console: true },
        minSeverity: 'critical',
        throttle: { enabled: false, windowMs: 60000, maxPerWindow: 10 },
      });
      expect(manager1).not.toBe(manager2);
      expect(getAlertManager()).toBe(manager2);
    });
  });
});
