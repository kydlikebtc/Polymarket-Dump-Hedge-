/**
 * Polymarket REST API 客户端
 * 处理订单提交、查询等 REST 操作
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
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

export class PolymarketClient {
  private config: BotConfig;
  private httpClient: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private signer: ethers.Signer | null = null;

  constructor(config: BotConfig) {
    this.config = config;

    // 创建 HTTP 客户端
    this.httpClient = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 添加请求拦截器用于签名
    this.httpClient.interceptors.request.use(
      async (config) => {
        // 添加认证头 (如果需要)
        if (this.wallet) {
          const timestamp = Date.now().toString();
          const signature = await this.signMessage(timestamp);
          config.headers['X-Timestamp'] = timestamp;
          config.headers['X-Signature'] = signature;
          config.headers['X-Address'] = this.wallet.address;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

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

    logger.info('PolymarketClient initialized', {
      apiUrl: config.apiUrl,
      hasWallet: !!this.wallet,
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
      this.signer = this.wallet;
      logger.info('Wallet initialized', { address: this.wallet.address });
    } catch (error) {
      logger.error('Failed to initialize wallet', { error });
      throw new Error('Invalid private key');
    }
  }

  /**
   * 签名消息
   */
  private async signMessage(message: string): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }
    return this.wallet.signMessage(message);
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
    const orderId = `sim-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
   */
  getWalletAddress(): string | null {
    return this.wallet?.address || null;
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
