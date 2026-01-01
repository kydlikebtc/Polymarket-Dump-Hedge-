/**
 * MarketWatcher 单元测试
 *
 * 测试 WebSocket 连接管理、消息处理和价格缓冲功能
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import type { BotConfig, PriceSnapshot } from '../src/types/index.js';

// Mock WebSocket 模块 - 必须在顶部，工厂内完全自包含
vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');

  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 1;
    url: string;

    constructor(url: string) {
      super();
      this.url = url;
      setTimeout(() => this.emit('open'), 10);
    }

    send = vi.fn();
    ping = vi.fn();
    close = vi.fn().mockImplementation(function(this: MockWS, code?: number) {
      this.readyState = 3;
      this.emit('close', code || 1000, Buffer.from(''));
    });
    terminate = vi.fn().mockImplementation(function(this: MockWS) {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.from('Connection terminated'));
    });
  }

  return {
    default: MockWS,
    WebSocket: MockWS,
  };
});

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { MarketWatcher } from '../src/api/MarketWatcher.js';
import { eventBus } from '../src/utils/EventBus.js';

describe('MarketWatcher', () => {
  let watcher: MarketWatcher;
  let testConfig: BotConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    testConfig = {
      shares: 100,
      sumTarget: 0.95,
      movePct: 0.15,
      windowMin: 3,
      wsUrl: 'wss://test.polymarket.com/ws',
      apiUrl: 'https://test.polymarket.com',
      reconnectDelay: 1000,
      maxReconnects: 3,
      feeRate: 0.002,
      spreadBuffer: 0.01,
      privateKey: '',
      walletAddress: '',
      readOnly: true,
      dryRun: true,
    };

    watcher = new MarketWatcher(testConfig);
  });

  afterEach(async () => {
    watcher.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('初始化', () => {
    it('应该正确初始化', () => {
      expect(watcher).toBeDefined();
      expect(watcher.getConnectionState()).toBe('disconnected');
      expect(watcher.isConnected()).toBe(false);
    });

    it('应该有空的价格缓冲区', () => {
      const buffer = watcher.getPriceBuffer();
      expect(buffer.size).toBe(0);
    });

    it('应该没有最新价格', () => {
      expect(watcher.getLatestPrice()).toBeUndefined();
    });
  });

  describe('连接管理', () => {
    it('connect() 应该建立连接', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      expect(watcher.getConnectionState()).toBe('connected');
      expect(watcher.isConnected()).toBe(true);
    });

    it('连接成功应该触发 ws:connected 事件', async () => {
      const eventSpy = vi.spyOn(eventBus, 'emitEvent');

      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      expect(eventSpy).toHaveBeenCalledWith('ws:connected');
    });

    it('重复连接应该被忽略', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      // 第二次连接应该立即返回
      await watcher.connect();
      expect(watcher.isConnected()).toBe(true);
    });

    it('disconnect() 应该断开连接', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      watcher.disconnect();
      expect(watcher.getConnectionState()).toBe('disconnected');
      expect(watcher.isConnected()).toBe(false);
    });
  });

  describe('订阅管理', () => {
    beforeEach(async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;
    });

    it('subscribe() 应该发送订阅消息 (CLOB v2 格式)', () => {
      watcher.subscribe('test-token-id');

      // 获取内部 ws 实例
      const ws = (watcher as unknown as { ws: { send: Mock } }).ws;
      expect(ws.send).toHaveBeenCalled();

      const callArg = ws.send.mock.calls[0][0];
      const message = JSON.parse(callArg);
      // Polymarket CLOB v2 WebSocket 格式
      expect(message.type).toBe('MARKET');
      expect(message.assets_ids).toEqual(['test-token-id']);
    });

    it('subscribeMultiple() 应该批量订阅多个 token', () => {
      watcher.subscribeMultiple(['token-1', 'token-2']);

      const ws = (watcher as unknown as { ws: { send: Mock } }).ws;
      expect(ws.send).toHaveBeenCalled();

      const callArg = ws.send.mock.calls[0][0];
      const message = JSON.parse(callArg);
      expect(message.type).toBe('MARKET');
      expect(message.assets_ids).toEqual(['token-1', 'token-2']);
    });

    it('unsubscribe() 应该从订阅集合中移除', () => {
      watcher.subscribe('test-token-id');
      watcher.unsubscribe('test-token-id');

      // unsubscribe 目前只从内部集合移除，不发送取消订阅消息
      // 因为 Polymarket CLOB v2 API 不需要显式取消订阅
      const subscriptions = (watcher as unknown as { subscriptions: Set<string> }).subscriptions;
      expect(subscriptions.has('test-token-id')).toBe(false);
    });
  });

  describe('消息处理', () => {
    let ws: { emit: (event: string, data: unknown) => void; send: Mock; ping: Mock; terminate: Mock };

    beforeEach(async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;
      ws = (watcher as unknown as { ws: typeof ws }).ws;
    });

    it('应该处理有效的价格更新消息', () => {
      const priceMessage = JSON.stringify({
        type: 'price_update',
        market: 'BTC-15min-test',
        up_best_ask: 0.45,
        up_best_bid: 0.44,
        down_best_ask: 0.55,
        down_best_bid: 0.54,
        seconds_remaining: 600,
      });

      ws.emit('message', Buffer.from(priceMessage));

      const latestPrice = watcher.getLatestPrice();
      expect(latestPrice).toBeDefined();
      expect(latestPrice?.upBestAsk).toBe(0.45);
      expect(latestPrice?.downBestAsk).toBe(0.55);
    });

    it('应该处理 CLOB v2 数组格式的 orderbook 消息', () => {
      // 首先设置 Token IDs
      watcher.setTokenIds('up-token-id', 'down-token-id');

      // CLOB v2 返回数组格式
      const orderbookMessage = JSON.stringify([
        {
          event_type: 'book',
          asset_id: 'up-token-id',
          bids: [{ price: '0.44', size: '100' }, { price: '0.43', size: '200' }],
          asks: [{ price: '0.45', size: '100' }, { price: '0.46', size: '200' }],
          hash: 'test-hash-1',
        },
        {
          event_type: 'book',
          asset_id: 'down-token-id',
          bids: [{ price: '0.54', size: '100' }],
          asks: [{ price: '0.55', size: '100' }],
          hash: 'test-hash-2',
        },
      ]);

      ws.emit('message', Buffer.from(orderbookMessage));

      const latestPrice = watcher.getLatestPrice();
      expect(latestPrice).toBeDefined();
      expect(latestPrice?.upBestAsk).toBe(0.45);
      expect(latestPrice?.upBestBid).toBe(0.44);
      expect(latestPrice?.downBestAsk).toBe(0.55);
      expect(latestPrice?.downBestBid).toBe(0.54);
    });

    it('应该处理市场信息消息', () => {
      const marketInfoMessage = JSON.stringify({
        type: 'market_info',
        slug: 'BTC-15min-test',
        up_token_id: 'up-token',
        down_token_id: 'down-token',
        start_time: Date.now(),
        end_time: Date.now() + 900000,
        status: 'active',
      });

      ws.emit('message', Buffer.from(marketInfoMessage));

      const market = watcher.getCurrentMarket();
      expect(market).toBeDefined();
      expect(market?.roundSlug).toBe('BTC-15min-test');
      expect(market?.status).toBe('active');
    });

    it('应该拒绝超大消息', () => {
      // 创建一个超过 1MB 的消息
      const largeMessage = 'x'.repeat(1024 * 1024 + 1);

      ws.emit('message', Buffer.from(largeMessage));

      // 缓冲区应该仍然为空
      expect(watcher.getPriceBuffer().size).toBe(0);
    });

    it('应该拒绝无效 JSON 消息', () => {
      ws.emit('message', Buffer.from('invalid json {{{'));

      expect(watcher.getPriceBuffer().size).toBe(0);
    });

    it('应该拒绝非对象消息', () => {
      ws.emit('message', Buffer.from('"just a string"'));
      ws.emit('message', Buffer.from('123'));
      ws.emit('message', Buffer.from('null'));
      ws.emit('message', Buffer.from('[1,2,3]'));

      expect(watcher.getPriceBuffer().size).toBe(0);
    });

    it('应该拒绝无效的价格更新消息结构', () => {
      const invalidPriceMessage = JSON.stringify({
        type: 'price_update',
        // 缺少必要字段
      });

      ws.emit('message', Buffer.from(invalidPriceMessage));

      expect(watcher.getPriceBuffer().size).toBe(0);
    });

    it('应该处理订阅确认消息', () => {
      const subscribeConfirm = JSON.stringify({
        type: 'subscribed',
        market: 'test-market',
      });

      // 不应抛出错误
      expect(() => {
        ws.emit('message', Buffer.from(subscribeConfirm));
      }).not.toThrow();
    });

    it('应该处理服务端错误消息', () => {
      const errorMessage = JSON.stringify({
        type: 'error',
        code: 'RATE_LIMIT',
        message: 'Too many requests',
      });

      // 不应抛出错误
      expect(() => {
        ws.emit('message', Buffer.from(errorMessage));
      }).not.toThrow();
    });
  });

  describe('价格缓冲区', () => {
    let ws: { emit: (event: string, data: unknown) => void };

    beforeEach(async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;
      ws = (watcher as unknown as { ws: typeof ws }).ws;
    });

    it('应该正确存储价格快照', () => {
      // 发送多个价格更新
      for (let i = 0; i < 5; i++) {
        const priceMessage = JSON.stringify({
          type: 'price_update',
          market: 'BTC-15min-test',
          up_best_ask: 0.45 + i * 0.01,
          down_best_ask: 0.55 - i * 0.01,
        });
        ws.emit('message', Buffer.from(priceMessage));
      }

      expect(watcher.getPriceBuffer().size).toBe(5);
    });

    it('getLatestPrice() 应该返回最新的价格', () => {
      const priceMessage1 = JSON.stringify({
        type: 'price_update',
        market: 'test',
        up_best_ask: 0.40,
        down_best_ask: 0.60,
      });

      const priceMessage2 = JSON.stringify({
        type: 'price_update',
        market: 'test',
        up_best_ask: 0.45,
        down_best_ask: 0.55,
      });

      ws.emit('message', Buffer.from(priceMessage1));
      ws.emit('message', Buffer.from(priceMessage2));

      const latest = watcher.getLatestPrice();
      expect(latest?.upBestAsk).toBe(0.45);
      expect(latest?.downBestAsk).toBe(0.55);
    });

    it('getRecentPrices() 应该返回最近时间段的价格', () => {
      vi.useRealTimers();

      const newWatcher = new MarketWatcher(testConfig);
      const buffer = newWatcher.getPriceBuffer();

      // 手动添加测试数据到缓冲区
      const now = Date.now();
      const snapshot1: PriceSnapshot = {
        timestamp: now - 5000, // 5秒前
        roundSlug: 'test',
        secondsRemaining: 600,
        upTokenId: 'up',
        downTokenId: 'down',
        upBestAsk: 0.40,
        upBestBid: 0.39,
        downBestAsk: 0.60,
        downBestBid: 0.59,
      };

      const snapshot2: PriceSnapshot = {
        timestamp: now - 1000, // 1秒前
        roundSlug: 'test',
        secondsRemaining: 600,
        upTokenId: 'up',
        downTokenId: 'down',
        upBestAsk: 0.45,
        upBestBid: 0.44,
        downBestAsk: 0.55,
        downBestBid: 0.54,
      };

      buffer.push(snapshot1);
      buffer.push(snapshot2);

      const recent = newWatcher.getRecentPrices(3000); // 最近3秒
      expect(recent.length).toBe(1);
      expect(recent[0].upBestAsk).toBe(0.45);

      newWatcher.disconnect();
      vi.useFakeTimers();
    });
  });

  describe('重连机制', () => {
    it('异常断开应该触发重连', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { emit: (event: string, code: number, reason: Buffer) => void } }).ws;

      // 模拟异常断开
      ws.emit('close', 1006, Buffer.from('Connection lost'));

      // 状态应该立即变为 reconnecting（因为会立即调度重连）
      expect(['disconnected', 'reconnecting']).toContain(watcher.getConnectionState());

      // 等待重连延迟
      vi.advanceTimersByTime(1000);

      expect(watcher.getReconnectAttempts()).toBeGreaterThan(0);
    });

    it('正常关闭不应触发重连', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { emit: (event: string, code: number, reason: Buffer) => void } }).ws;

      // 正常关闭 (code 1000)
      ws.emit('close', 1000, Buffer.from('Normal closure'));

      // 等待可能的重连
      vi.advanceTimersByTime(2000);

      expect(watcher.getReconnectAttempts()).toBe(0);
    });

    it('超过最大重连次数应该停止重连', async () => {
      const eventSpy = vi.spyOn(eventBus, 'emitEvent');

      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      // 设置重连次数接近最大值
      (watcher as unknown as { reconnectAttempts: number }).reconnectAttempts = testConfig.maxReconnects;

      const ws = (watcher as unknown as { ws: { emit: (event: string, code: number, reason: Buffer) => void } }).ws;
      ws.emit('close', 1006, Buffer.from('Connection lost'));

      // 等待
      vi.advanceTimersByTime(10000);

      // 应该触发系统错误事件
      expect(eventSpy).toHaveBeenCalledWith('system:error', expect.any(Error));
    });
  });

  describe('心跳机制', () => {
    it('连接后应该启动心跳', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { ping: Mock } }).ws;

      // 等待心跳间隔
      vi.advanceTimersByTime(30000);

      expect(ws.ping).toHaveBeenCalled();
    });

    it('pong 响应应该更新最后心跳时间', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { emit: (event: string) => void } }).ws;
      const beforePong = (watcher as unknown as { lastHeartbeat: number }).lastHeartbeat;

      vi.advanceTimersByTime(1000);
      ws.emit('pong');

      const afterPong = (watcher as unknown as { lastHeartbeat: number }).lastHeartbeat;
      expect(afterPong).toBeGreaterThanOrEqual(beforePong);
    });

    it('心跳超时应该断开连接', async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { terminate: Mock } }).ws;

      // 设置最后心跳时间为很久以前
      (watcher as unknown as { lastHeartbeat: number }).lastHeartbeat = Date.now() - 70000;

      // 触发心跳检查
      vi.advanceTimersByTime(30000);

      expect(ws.terminate).toHaveBeenCalled();
    });
  });

  describe('错误处理', () => {
    it('WebSocket 错误应该触发事件', async () => {
      const eventSpy = vi.spyOn(eventBus, 'emitEvent');

      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;

      const ws = (watcher as unknown as { ws: { emit: (event: string, error: Error) => void } }).ws;
      const testError = new Error('Test WebSocket error');

      ws.emit('error', testError);

      expect(eventSpy).toHaveBeenCalledWith('ws:error', testError);
    });
  });

  describe('价格解析', () => {
    let ws: { emit: (event: string, data: unknown) => void };

    beforeEach(async () => {
      const connectPromise = watcher.connect();
      vi.advanceTimersByTime(20);
      await connectPromise;
      ws = (watcher as unknown as { ws: typeof ws }).ws;
    });

    it('应该正确解析数字价格', () => {
      const message = JSON.stringify({
        type: 'price_update',
        market: 'test',
        up_best_ask: 0.45,
        down_best_ask: 0.55,
      });

      ws.emit('message', Buffer.from(message));

      expect(watcher.getLatestPrice()?.upBestAsk).toBe(0.45);
    });

    it('应该正确解析字符串价格', () => {
      const message = JSON.stringify({
        type: 'price_update',
        market: 'test',
        up_best_ask: '0.45',
        down_best_ask: '0.55',
      });

      ws.emit('message', Buffer.from(message));

      expect(watcher.getLatestPrice()?.upBestAsk).toBe(0.45);
    });

    it('无效价格应该解析为 0', () => {
      const message = JSON.stringify({
        type: 'price_update',
        market: 'test',
        up_best_ask: 'not-a-number',
        down_best_ask: 0.55,
      });

      ws.emit('message', Buffer.from(message));

      // 至少 down_best_ask 有效，所以消息应该被处理
      expect(watcher.getLatestPrice()?.upBestAsk).toBe(0);
      expect(watcher.getLatestPrice()?.downBestAsk).toBe(0.55);
    });
  });
});
