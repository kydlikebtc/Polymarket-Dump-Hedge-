/**
 * Polymarket REST API 客户端
 * 处理订单提交、查询等 REST 操作
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import https from 'https';
import { randomUUID, createHash, createHmac } from 'crypto';
import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/index.js';
import type {
  BotConfig,
  Order,
  OrderResult,
  Side,
  OrderType,
  MarketInfo,
} from '../types/index.js';

// API 错误类型
interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// 订单请求类型
interface CreateOrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'GTC' | 'FOK';
  size: string;
  price?: string;
}

// 订单响应类型
interface OrderResponse {
  id: string;
  status: string;
  filledSize: string;
  avgFillPrice: string;
  totalCost: string;
  createdAt: string;
  updatedAt: string;
}

// SEC-006: 时间戳容忍窗口 (毫秒)
const TIMESTAMP_TOLERANCE_MS = 30000; // 30 秒

/**
 * Builder API 凭据接口
 */
interface BuilderCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export class PolymarketClient {
  private config: BotConfig;
  private httpClient: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private walletAddress: string | null = null; // 缓存地址，钱包清除后仍可访问
  private usedNonces: Set<string> = new Set(); // SEC-006: 防止 nonce 重放
  private nonceCleanupInterval: NodeJS.Timeout | null = null;
  private builderCreds: BuilderCreds | null = null; // Builder API 凭据

  constructor(config: BotConfig) {
    this.config = config;

    // 创建 HTTPS Agent，显式启用证书验证 (SEC-003)
    const httpsAgent = new https.Agent({
      rejectUnauthorized: true, // 拒绝无效证书
      minVersion: 'TLSv1.2',    // 最低 TLS 版本
    });

    // 创建 HTTP 客户端
    this.httpClient = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      httpsAgent,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 添加请求拦截器用于签名 (SEC-006: 增强签名机制)
    this.httpClient.interceptors.request.use(
      async (requestConfig: InternalAxiosRequestConfig) => {
        // 添加钱包认证头 (如果需要)
        if (this.wallet) {
          const signatureData = await this.createSignedRequest(requestConfig);
          requestConfig.headers['X-Timestamp'] = signatureData.timestamp;
          requestConfig.headers['X-Nonce'] = signatureData.nonce;
          requestConfig.headers['X-Signature'] = signatureData.signature;
          requestConfig.headers['X-Address'] = this.wallet.address;
        }

        // 添加 Builder API 认证头 (订单归因)
        if (this.builderCreds) {
          const builderAuth = this.createBuilderAuthHeaders(requestConfig);
          requestConfig.headers['POLY_API_KEY'] = builderAuth.apiKey;
          requestConfig.headers['POLY_SIGNATURE'] = builderAuth.signature;
          requestConfig.headers['POLY_TIMESTAMP'] = builderAuth.timestamp;
          requestConfig.headers['POLY_PASSPHRASE'] = builderAuth.passphrase;
        }

        return requestConfig;
      },
      (error) => Promise.reject(error)
    );

    // SEC-006: 启动 nonce 清理定时器 (每分钟清理过期 nonce)
    this.startNonceCleanup();

    // 添加响应拦截器用于错误处理
    this.httpClient.interceptors.response.use(
      (response) => response,
      (error: AxiosError<ApiError>) => {
        if (error.response) {
          const apiError = error.response.data;
          logger.error('API error response', {
            status: error.response.status,
            code: apiError?.code,
            message: apiError?.message,
          });
        }
        return Promise.reject(error);
      }
    );

    // 初始化钱包 (如果提供了私钥)
    if (config.privateKey && !config.dryRun && !config.readOnly) {
      this.initWallet(config.privateKey);
    }

    // 初始化 Builder API 凭据 (如果提供)
    if (config.builderApiKey && config.builderSecret && config.builderPassphrase) {
      this.builderCreds = {
        key: config.builderApiKey,
        secret: config.builderSecret,
        passphrase: config.builderPassphrase,
      };
      logger.info('Builder API credentials configured');
    }

    logger.info('PolymarketClient initialized', {
      apiUrl: config.apiUrl,
      hasWallet: !!this.wallet,
      hasBuilderCreds: !!this.builderCreds,
      dryRun: config.dryRun,
      readOnly: config.readOnly,
    });
  }

  /**
   * 初始化钱包
   */
  private initWallet(privateKey: string): void {
    try {
      this.wallet = new ethers.Wallet(privateKey);
      this.walletAddress = this.wallet.address; // 缓存地址
      logger.info('Wallet initialized', { address: this.walletAddress });
    } catch (error) {
      logger.error('Failed to initialize wallet', { error });
      throw new Error('Invalid private key');
    }
  }

  /**
   * 清除钱包私钥 (SEC-001)
   * 在不需要签名时调用，减少私钥在内存中的暴露时间
   */
  clearWallet(): void {
    if (this.wallet) {
      // 注意: ethers.js v6 的 Wallet 对象无法直接清除私钥
      // 但我们可以解除引用，让 GC 回收
      this.wallet = null;
      logger.info('Wallet cleared from memory', { address: this.walletAddress });
    }
  }

  /**
   * 检查钱包是否已初始化
   */
  hasWallet(): boolean {
    return this.wallet !== null;
  }

  /**
   * 重新初始化钱包 (如果之前被清除)
   */
  reinitializeWallet(): boolean {
    if (this.wallet) {
      return true; // 已经初始化
    }

    if (this.config.privateKey && !this.config.dryRun && !this.config.readOnly) {
      this.initWallet(this.config.privateKey);
      return true;
    }

    return false;
  }

  /**
   * SEC-006: 创建带签名的请求数据
   * 签名内容包括: 时间戳 + nonce + 请求方法 + 请求路径 + 请求体哈希
   */
  private async createSignedRequest(requestConfig: InternalAxiosRequestConfig): Promise<{
    timestamp: string;
    nonce: string;
    signature: string;
  }> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const method = (requestConfig.method || 'GET').toUpperCase();
    const path = requestConfig.url || '/';

    // 计算请求体哈希 (如果有)
    let bodyHash = '';
    if (requestConfig.data) {
      const bodyStr = typeof requestConfig.data === 'string'
        ? requestConfig.data
        : JSON.stringify(requestConfig.data);
      bodyHash = createHash('sha256').update(bodyStr).digest('hex');
    }

    // 构建签名消息
    const signatureMessage = `${timestamp}:${nonce}:${method}:${path}:${bodyHash}`;

    // 使用钱包签名
    const signature = await this.wallet.signMessage(signatureMessage);

    // 记录 nonce 防止重放
    this.usedNonces.add(`${nonce}:${timestamp}`);

    logger.debug('Created signed request', {
      method,
      path,
      hasBody: !!bodyHash,
      nonceCount: this.usedNonces.size,
    });

    return { timestamp, nonce, signature };
  }

  /**
   * SEC-006: 启动 nonce 清理定时器
   * 定期清理过期的 nonce，防止内存泄漏
   */
  private startNonceCleanup(): void {
    // 每分钟清理一次过期 nonce
    this.nonceCleanupInterval = setInterval(() => {
      const now = Date.now();
      const expiredNonces: string[] = [];

      for (const entry of this.usedNonces) {
        const [, timestampStr] = entry.split(':');
        const timestamp = parseInt(timestampStr, 10);
        // 清理超过容忍窗口两倍时间的 nonce
        if (now - timestamp > TIMESTAMP_TOLERANCE_MS * 2) {
          expiredNonces.push(entry);
        }
      }

      for (const expired of expiredNonces) {
        this.usedNonces.delete(expired);
      }

      if (expiredNonces.length > 0) {
        logger.debug('Cleaned up expired nonces', { count: expiredNonces.length });
      }
    }, 60000);
  }

  /**
   * SEC-006: 停止 nonce 清理定时器
   */
  stopNonceCleanup(): void {
    if (this.nonceCleanupInterval) {
      clearInterval(this.nonceCleanupInterval);
      this.nonceCleanupInterval = null;
    }
  }

  /**
   * 创建 Builder API 认证头
   * 使用 HMAC-SHA256 签名请求
   */
  private createBuilderAuthHeaders(requestConfig: InternalAxiosRequestConfig): {
    apiKey: string;
    signature: string;
    timestamp: string;
    passphrase: string;
  } {
    if (!this.builderCreds) {
      throw new Error('Builder credentials not configured');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = (requestConfig.method || 'GET').toUpperCase();
    const path = requestConfig.url || '/';

    // 构建签名消息: timestamp + method + path + body
    let body = '';
    if (requestConfig.data) {
      body = typeof requestConfig.data === 'string'
        ? requestConfig.data
        : JSON.stringify(requestConfig.data);
    }

    const message = timestamp + method + path + body;

    // 使用 HMAC-SHA256 签名
    const signature = createHmac('sha256', Buffer.from(this.builderCreds.secret, 'base64'))
      .update(message)
      .digest('base64');

    logger.debug('Created Builder API auth headers', {
      method,
      path,
      hasBody: !!body,
    });

    return {
      apiKey: this.builderCreds.key,
      signature,
      timestamp,
      passphrase: this.builderCreds.passphrase,
    };
  }

  /**
   * 检查是否配置了 Builder API 凭据
   */
  hasBuilderCreds(): boolean {
    return this.builderCreds !== null;
  }

  /**
   * 获取市场列表
   */
  async getMarkets(): Promise<MarketInfo[]> {
    try {
      const response = await this.httpClient.get('/markets');
      return response.data as MarketInfo[];
    } catch (error) {
      logger.error('Failed to get markets', { error });
      throw error;
    }
  }

  /**
   * 获取特定市场信息
   */
  async getMarket(tokenId: string): Promise<MarketInfo> {
    try {
      const response = await this.httpClient.get(`/markets/${tokenId}`);
      return response.data as MarketInfo;
    } catch (error) {
      logger.error('Failed to get market', { error, tokenId });
      throw error;
    }
  }

  /**
   * 获取订单簿
   */
  async getOrderBook(tokenId: string): Promise<{
    bids: [number, number][];
    asks: [number, number][];
  }> {
    try {
      const response = await this.httpClient.get(`/orderbook/${tokenId}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to get orderbook', { error, tokenId });
      throw error;
    }
  }

  /**
   * 获取账户余额
   */
  async getBalance(): Promise<{ available: number; locked: number }> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    try {
      const response = await this.httpClient.get(`/balance/${this.wallet.address}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to get balance', { error });
      throw error;
    }
  }

  /**
   * 按 USD 金额买入
   */
  async buyByUsd(
    side: Side,
    tokenId: string,
    usdAmount: number
  ): Promise<OrderResult> {
    logger.info(`Buying ${side} for $${usdAmount}`, { tokenId, usdAmount });

    if (this.config.dryRun) {
      return this.simulateOrder(side, 'MARKET', usdAmount / 0.5, usdAmount);
    }

    const order: CreateOrderRequest = {
      tokenId,
      side: 'BUY',
      type: 'MARKET',
      size: usdAmount.toString(),
    };

    return this.submitOrder(order, side);
  }

  /**
   * 按份数买入 (Limit Order)
   */
  async buyByShares(
    side: Side,
    tokenId: string,
    shares: number,
    price: number
  ): Promise<OrderResult> {
    logger.info(`Buying ${shares} ${side} shares at ${price}`, { tokenId, shares, price });

    if (this.config.dryRun) {
      return this.simulateOrder(side, 'LIMIT', shares, shares * price);
    }

    const order: CreateOrderRequest = {
      tokenId,
      side: 'BUY',
      type: 'GTC', // Good Till Cancelled
      size: shares.toString(),
      price: price.toString(),
    };

    return this.submitOrder(order, side);
  }

  /**
   * 市价买入指定份数
   */
  async buyMarketShares(
    side: Side,
    tokenId: string,
    shares: number
  ): Promise<OrderResult> {
    logger.info(`Market buying ${shares} ${side} shares`, { tokenId, shares });

    if (this.config.dryRun) {
      return this.simulateOrder(side, 'MARKET', shares, shares * 0.5);
    }

    const order: CreateOrderRequest = {
      tokenId,
      side: 'BUY',
      type: 'FOK', // Fill or Kill
      size: shares.toString(),
    };

    return this.submitOrder(order, side);
  }

  /**
   * 提交订单
   */
  private async submitOrder(
    order: CreateOrderRequest,
    side: Side
  ): Promise<OrderResult> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    if (this.config.readOnly) {
      throw new Error('Cannot submit orders in read-only mode');
    }

    try {
      // 使用重试机制
      const response = await withRetry(
        async () => {
          const res = await this.httpClient.post<OrderResponse>('/order', order);
          return res;
        },
        {
          maxRetries: 3,
          backoffMs: 1000,
          onRetry: (attempt, error) => {
            logger.warn(`Order submission retry ${attempt}`, { error: error.message });
          },
        }
      );

      const data = response.data;

      const result: OrderResult = {
        orderId: data.id,
        side,
        shares: parseFloat(data.filledSize),
        avgPrice: parseFloat(data.avgFillPrice),
        totalCost: parseFloat(data.totalCost),
        status: this.mapOrderStatus(data.status),
        timestamp: new Date(data.createdAt).getTime(),
      };

      logger.info('Order submitted successfully', result);
      return result;

    } catch (error) {
      const axiosError = error as AxiosError<ApiError>;
      const apiError = axiosError.response?.data;

      logger.error('Order submission failed', {
        error: apiError?.message || axiosError.message,
        code: apiError?.code,
      });

      return {
        orderId: '',
        side,
        shares: 0,
        avgPrice: 0,
        totalCost: 0,
        status: 'rejected',
        timestamp: Date.now(),
        error: apiError?.message || 'Order submission failed',
      };
    }
  }

  /**
   * 模拟订单 (Dry Run 模式)
   */
  private simulateOrder(
    side: Side,
    orderType: OrderType,
    shares: number,
    totalCost: number
  ): OrderResult {
    // 使用加密安全的随机 UUID (SEC-005)
    const orderId = `sim-${randomUUID()}`;
    const avgPrice = totalCost / shares;

    logger.info('Simulated order (dry run)', {
      orderId,
      side,
      orderType,
      shares,
      avgPrice,
      totalCost,
    });

    return {
      orderId,
      side,
      shares,
      avgPrice,
      totalCost,
      status: 'filled',
      timestamp: Date.now(),
    };
  }

  /**
   * 映射订单状态
   */
  private mapOrderStatus(status: string): OrderResult['status'] {
    const statusMap: Record<string, OrderResult['status']> = {
      'FILLED': 'filled',
      'PARTIAL': 'partial',
      'PENDING': 'pending',
      'OPEN': 'pending',
      'CANCELLED': 'rejected',
      'REJECTED': 'rejected',
    };
    return statusMap[status.toUpperCase()] || 'pending';
  }

  /**
   * 查询订单状态
   */
  async getOrderStatus(orderId: string): Promise<Order | null> {
    try {
      const response = await this.httpClient.get<OrderResponse>(`/order/${orderId}`);
      const data = response.data;

      return {
        id: data.id,
        side: 'UP', // 需要从其他地方获取
        orderType: 'MARKET',
        shares: parseFloat(data.filledSize),
        avgFillPrice: parseFloat(data.avgFillPrice),
        totalCost: parseFloat(data.totalCost),
        status: this.mapOrderStatusToOrderStatus(data.status),
        createdAt: new Date(data.createdAt).getTime(),
        filledAt: data.updatedAt ? new Date(data.updatedAt).getTime() : undefined,
      };

    } catch (error) {
      logger.error('Failed to get order status', { error, orderId });
      return null;
    }
  }

  /**
   * 映射订单状态到 Order['status']
   */
  private mapOrderStatusToOrderStatus(status: string): Order['status'] {
    const statusMap: Record<string, Order['status']> = {
      'FILLED': 'FILLED',
      'PARTIAL': 'PARTIAL',
      'PENDING': 'PENDING',
      'OPEN': 'PENDING',
      'CANCELLED': 'CANCELLED',
      'REJECTED': 'REJECTED',
    };
    return statusMap[status.toUpperCase()] || 'PENDING';
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.config.dryRun) {
      logger.info('Simulated cancel order (dry run)', { orderId });
      return true;
    }

    try {
      await this.httpClient.delete(`/order/${orderId}`);
      logger.info('Order cancelled', { orderId });
      return true;
    } catch (error) {
      logger.error('Failed to cancel order', { error, orderId });
      return false;
    }
  }

  /**
   * 获取钱包地址
   * 即使钱包已清除，仍返回缓存的地址
   */
  getWalletAddress(): string | null {
    return this.walletAddress;
  }

  /**
   * 检查是否可以交易
   */
  canTrade(): boolean {
    return !this.config.readOnly && !this.config.dryRun && !!this.wallet;
  }

  /**
   * 检查是否为 Dry Run 模式
   */
  isDryRun(): boolean {
    return this.config.dryRun;
  }
}

export default PolymarketClient;
