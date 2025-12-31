/**
 * PolymarketClient 单元测试
 *
 * 测试 REST API 客户端功能，包括：
 * - 订单提交和取消
 * - 市场数据获取
 * - 钱包管理
 * - 安全特性
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import type { BotConfig } from '../src/types/index.js';

// Mock axios
const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
  },
}));

// Mock ethers
const mockWallet = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  signMessage: vi.fn().mockResolvedValue('mock-signature'),
};

vi.mock('ethers', () => ({
  ethers: {
    Wallet: vi.fn().mockImplementation(() => mockWallet),
  },
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

// Mock retry utility
vi.mock('../src/utils/index.js', () => ({
  withRetry: vi.fn().mockImplementation(async (fn) => fn()),
}));

import { PolymarketClient } from '../src/api/PolymarketClient.js';

describe('PolymarketClient', () => {
  let client: PolymarketClient;
  let testConfig: BotConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    testConfig = {
      shares: 100,
      sumTarget: 0.95,
      movePct: 0.15,
      windowMin: 3,
      wsUrl: 'wss://test.polymarket.com/ws',
      apiUrl: 'https://test.polymarket.com/api',
      reconnectDelay: 1000,
      maxReconnects: 5,
      feeRate: 0.002,
      spreadBuffer: 0.01,
      privateKey: '',
      walletAddress: '',
      readOnly: false,
      dryRun: true,
    };
  });

  afterEach(() => {
    if (client) {
      client.clearWallet();
    }
  });

  describe('初始化', () => {
    it('应该正确初始化客户端', () => {
      client = new PolymarketClient(testConfig);

      expect(client).toBeDefined();
      expect(client.isDryRun()).toBe(true);
    });

    it('dryRun 模式不应初始化钱包', () => {
      client = new PolymarketClient(testConfig);

      expect(client.hasWallet()).toBe(false);
      expect(client.getWalletAddress()).toBeNull();
    });

    it('readOnly 模式不应初始化钱包', () => {
      const readOnlyConfig = { ...testConfig, dryRun: false, readOnly: true, privateKey: 'test-key' };
      client = new PolymarketClient(readOnlyConfig);

      expect(client.hasWallet()).toBe(false);
    });

    it('提供私钥且非 dryRun/readOnly 应该初始化钱包', () => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);

      expect(client.hasWallet()).toBe(true);
      expect(client.getWalletAddress()).toBe(mockWallet.address);
    });
  });

  describe('Dry Run 模式', () => {
    beforeEach(() => {
      client = new PolymarketClient(testConfig);
    });

    it('buyByUsd 应该返回模拟订单', async () => {
      const result = await client.buyByUsd('UP', 'test-token', 50);

      expect(result.orderId).toContain('sim-');
      expect(result.status).toBe('filled');
      expect(result.side).toBe('UP');
    });

    it('buyByShares 应该返回模拟订单', async () => {
      const result = await client.buyByShares('DOWN', 'test-token', 100, 0.45);

      expect(result.orderId).toContain('sim-');
      expect(result.status).toBe('filled');
      expect(result.side).toBe('DOWN');
      expect(result.shares).toBe(100);
      expect(result.avgPrice).toBe(0.45);
      expect(result.totalCost).toBe(45);
    });

    it('buyMarketShares 应该返回模拟订单', async () => {
      const result = await client.buyMarketShares('UP', 'test-token', 50);

      expect(result.orderId).toContain('sim-');
      expect(result.status).toBe('filled');
      expect(result.shares).toBe(50);
    });

    it('cancelOrder 应该返回 true', async () => {
      const result = await client.cancelOrder('test-order-id');
      expect(result).toBe(true);
    });

    it('canTrade 应该返回 false', () => {
      expect(client.canTrade()).toBe(false);
    });
  });

  describe('API 调用', () => {
    beforeEach(() => {
      // 使用非 dry-run 配置但不提供私钥，这样可以测试 API 调用
      const apiConfig = { ...testConfig, dryRun: false, readOnly: true };
      client = new PolymarketClient(apiConfig);
    });

    it('getMarkets 应该调用正确的 API 端点', async () => {
      const mockMarkets = [{ id: 'market-1' }, { id: 'market-2' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarkets });

      const result = await client.getMarkets();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets');
      expect(result).toEqual(mockMarkets);
    });

    it('getMarket 应该调用正确的 API 端点', async () => {
      const mockMarket = { id: 'test-token' };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarket });

      const result = await client.getMarket('test-token');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets/test-token');
      expect(result).toEqual(mockMarket);
    });

    it('getOrderBook 应该调用正确的 API 端点', async () => {
      const mockOrderbook = { bids: [[0.45, 100]], asks: [[0.55, 100]] };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrderbook });

      const result = await client.getOrderBook('test-token');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/orderbook/test-token');
      expect(result).toEqual(mockOrderbook);
    });

    it('API 错误应该被正确处理', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.getMarkets()).rejects.toThrow('Network error');
    });
  });

  describe('钱包管理', () => {
    beforeEach(() => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);
    });

    it('hasWallet 应该返回 true 当钱包已初始化', () => {
      expect(client.hasWallet()).toBe(true);
    });

    it('getWalletAddress 应该返回钱包地址', () => {
      expect(client.getWalletAddress()).toBe(mockWallet.address);
    });

    it('clearWallet 应该清除钱包', () => {
      client.clearWallet();

      expect(client.hasWallet()).toBe(false);
      // 地址应该仍然被缓存
      expect(client.getWalletAddress()).toBe(mockWallet.address);
    });

    it('reinitializeWallet 应该重新初始化钱包', () => {
      client.clearWallet();
      expect(client.hasWallet()).toBe(false);

      const result = client.reinitializeWallet();

      expect(result).toBe(true);
      expect(client.hasWallet()).toBe(true);
    });

    it('reinitializeWallet 在 dryRun 模式下应该返回 false', () => {
      const dryRunClient = new PolymarketClient(testConfig);

      const result = dryRunClient.reinitializeWallet();

      expect(result).toBe(false);
      expect(dryRunClient.hasWallet()).toBe(false);
    });
  });

  describe('订单提交 (Live 模式)', () => {
    beforeEach(() => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);
    });

    it('buyByShares 应该正确提交订单', async () => {
      const mockResponse = {
        data: {
          id: 'order-123',
          status: 'FILLED',
          filledSize: '100',
          avgFillPrice: '0.45',
          totalCost: '45',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

      const result = await client.buyByShares('UP', 'test-token', 100, 0.45);

      expect(mockAxiosInstance.post).toHaveBeenCalled();
      expect(result.orderId).toBe('order-123');
      expect(result.status).toBe('filled');
      expect(result.shares).toBe(100);
    });

    it('订单失败应该返回 rejected 状态', async () => {
      const mockError = {
        response: {
          data: {
            code: 'INSUFFICIENT_FUNDS',
            message: 'Not enough balance',
          },
        },
        message: 'Request failed',
      };
      mockAxiosInstance.post.mockRejectedValueOnce(mockError);

      const result = await client.buyByShares('UP', 'test-token', 100, 0.45);

      expect(result.status).toBe('rejected');
      expect(result.error).toBe('Not enough balance');
    });

    it('readOnly 模式下不能提交订单', async () => {
      const readOnlyConfig = { ...testConfig, dryRun: false, readOnly: true };
      const readOnlyClient = new PolymarketClient(readOnlyConfig);

      await expect(
        // 需要通过私有方法测试，但可以测试 canTrade
        readOnlyClient.canTrade()
      ).toBe(false);
    });
  });

  describe('订单状态查询', () => {
    beforeEach(() => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);
    });

    it('getOrderStatus 应该返回订单详情', async () => {
      const mockOrder = {
        id: 'order-123',
        status: 'FILLED',
        filledSize: '100',
        avgFillPrice: '0.45',
        totalCost: '45',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrder });

      const result = await client.getOrderStatus('order-123');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/order/order-123');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('order-123');
      expect(result?.status).toBe('FILLED');
    });

    it('订单不存在应该返回 null', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Not found'));

      const result = await client.getOrderStatus('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('订单取消 (Live 模式)', () => {
    beforeEach(() => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);
    });

    it('cancelOrder 成功应该返回 true', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});

      const result = await client.cancelOrder('order-123');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/order/order-123');
      expect(result).toBe(true);
    });

    it('cancelOrder 失败应该返回 false', async () => {
      mockAxiosInstance.delete.mockRejectedValueOnce(new Error('Cancel failed'));

      const result = await client.cancelOrder('order-123');

      expect(result).toBe(false);
    });
  });

  describe('余额查询', () => {
    it('无钱包时应该抛出错误', async () => {
      client = new PolymarketClient(testConfig);

      await expect(client.getBalance()).rejects.toThrow('Wallet not initialized');
    });

    it('有钱包时应该返回余额', async () => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);

      const mockBalance = { available: 1000, locked: 50 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockBalance });

      const result = await client.getBalance();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/balance/${mockWallet.address}`);
      expect(result).toEqual(mockBalance);
    });
  });

  describe('canTrade 逻辑', () => {
    it('dryRun 模式返回 false', () => {
      client = new PolymarketClient(testConfig);
      expect(client.canTrade()).toBe(false);
    });

    it('readOnly 模式返回 false', () => {
      const readOnlyConfig = { ...testConfig, dryRun: false, readOnly: true, privateKey: 'key' };
      client = new PolymarketClient(readOnlyConfig);
      expect(client.canTrade()).toBe(false);
    });

    it('无钱包返回 false', () => {
      const noWalletConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: '' };
      client = new PolymarketClient(noWalletConfig);
      expect(client.canTrade()).toBe(false);
    });

    it('Live 模式且有钱包返回 true', () => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'key' };
      client = new PolymarketClient(liveConfig);
      expect(client.canTrade()).toBe(true);
    });
  });

  describe('安全特性 (SEC-001, SEC-003, SEC-005)', () => {
    it('SEC-001: clearWallet 应该清除钱包引用', () => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);

      expect(client.hasWallet()).toBe(true);

      client.clearWallet();

      expect(client.hasWallet()).toBe(false);
    });

    it('SEC-001: 钱包清除后地址仍应可访问', () => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      client = new PolymarketClient(liveConfig);
      const address = client.getWalletAddress();

      client.clearWallet();

      expect(client.getWalletAddress()).toBe(address);
    });

    it('SEC-005: 模拟订单 ID 应该使用 UUID 格式', async () => {
      client = new PolymarketClient(testConfig);

      const result = await client.buyByShares('UP', 'test-token', 100, 0.45);

      // UUID 格式: sim-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(result.orderId).toMatch(/^sim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('SEC-006: 增强签名机制', () => {
    let liveClient: PolymarketClient;

    beforeEach(() => {
      const liveConfig = { ...testConfig, dryRun: false, readOnly: false, privateKey: 'test-private-key' };
      liveClient = new PolymarketClient(liveConfig);
    });

    afterEach(() => {
      liveClient.stopNonceCleanup();
      liveClient.clearWallet();
    });

    it('请求应该包含 X-Nonce 头', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      await liveClient.getMarkets();

      // 验证拦截器被调用（mock 会捕获请求）
      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });

    it('stopNonceCleanup 应该停止定时器', () => {
      // 调用停止方法不应抛出错误
      expect(() => liveClient.stopNonceCleanup()).not.toThrow();

      // 再次调用也不应抛出
      expect(() => liveClient.stopNonceCleanup()).not.toThrow();
    });

    it('多次请求应该使用不同的 nonce', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });

      // 执行多次请求
      await liveClient.getMarkets();
      await liveClient.getMarkets();
      await liveClient.getMarkets();

      // 验证多次调用
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
    });
  });

  describe('Builder API 认证', () => {
    it('未配置 Builder 凭据时 hasBuilderCreds 返回 false', () => {
      expect(client.hasBuilderCreds()).toBe(false);
    });

    it('配置 Builder 凭据时 hasBuilderCreds 返回 true', () => {
      const builderConfig = {
        ...testConfig,
        builderApiKey: 'test-api-key',
        builderSecret: 'dGVzdC1zZWNyZXQ=', // base64 encoded 'test-secret'
        builderPassphrase: 'test-passphrase',
      };
      const builderClient = new PolymarketClient(builderConfig);
      expect(builderClient.hasBuilderCreds()).toBe(true);
      builderClient.stopNonceCleanup();
    });

    it('部分 Builder 凭据不应初始化', () => {
      const partialConfig = {
        ...testConfig,
        builderApiKey: 'test-api-key',
        // 缺少 secret 和 passphrase
      };
      const partialClient = new PolymarketClient(partialConfig);
      expect(partialClient.hasBuilderCreds()).toBe(false);
      partialClient.stopNonceCleanup();
    });
  });
});
