/**
 * 市场监控器
 * 维护 WebSocket 连接，接收实时价格更新
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { CircularBuffer } from '../utils/CircularBuffer.js';
import { eventBus } from '../utils/EventBus.js';
import { sleep } from '../utils/index.js';
import type { PriceSnapshot, MarketInfo, BotConfig } from '../types/index.js';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class MarketWatcher {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  private reconnectAttempts: number = 0;
  private connectionState: ConnectionState = 'disconnected';
  private priceBuffer: CircularBuffer<PriceSnapshot>;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat: number = 0;
  private currentMarket: MarketInfo | null = null;
  private subscriptions: Set<string> = new Set();

  // 心跳配置
  private readonly HEARTBEAT_INTERVAL = 30000; // 30秒
  private readonly HEARTBEAT_TIMEOUT = 60000; // 60秒无响应视为断连

  constructor(config: BotConfig) {
    this.config = config;
    this.priceBuffer = new CircularBuffer<PriceSnapshot>(1000); // 最近1000个价格快照

    logger.info('MarketWatcher initialized', {
      wsUrl: config.wsUrl,
      bufferSize: 1000,
    });
  }

  /**
   * 连接到 WebSocket
   */
  async connect(): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      logger.warn('Already connected or connecting');
      return;
    }

    this.connectionState = 'connecting';
    logger.info('Connecting to Polymarket WebSocket...', { url: this.config.wsUrl });

    try {
      await this.establishConnection();
    } catch (error) {
      logger.error('Failed to establish WebSocket connection', { error });
      this.connectionState = 'disconnected';
      throw error;
    }
  }

  /**
   * 建立 WebSocket 连接
   */
  private establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this.handleOpen();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error: Error) => {
          this.handleError(error);
          if (this.connectionState === 'connecting') {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          this.lastHeartbeat = Date.now();
          logger.debug('Received pong from server');
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 处理连接打开
   */
  private handleOpen(): void {
    this.connectionState = 'connected';
    this.reconnectAttempts = 0;
    this.lastHeartbeat = Date.now();

    logger.info('WebSocket connected successfully');
    eventBus.emitEvent('ws:connected');

    // 启动心跳检测
    this.startHeartbeat();

    // 重新订阅之前的市场
    for (const tokenId of this.subscriptions) {
      this.subscribe(tokenId);
    }
  }

  /**
   * 处理接收的消息
   * 包含完整的消息验证以防止恶意或畸形消息导致崩溃
   */
  private handleMessage(data: WebSocket.RawData): void {
    // 步骤 1: 验证消息大小 (防止内存攻击)
    const dataStr = data.toString();
    const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
    if (dataStr.length > MAX_MESSAGE_SIZE) {
      logger.warn('Message too large, dropping', { size: dataStr.length, maxSize: MAX_MESSAGE_SIZE });
      return;
    }

    // 步骤 2: 解析 JSON
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(dataStr);
    } catch (parseError) {
      logger.error('Failed to parse WebSocket message as JSON', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        dataPreview: dataStr.substring(0, 200),
      });
      return;
    }

    // 步骤 3: 验证消息是对象
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      logger.warn('Invalid message format: expected object', { type: typeof message });
      return;
    }

    this.lastHeartbeat = Date.now();

    // 步骤 4: 根据消息类型处理 (带类型验证)
    const messageType = message.type ?? message.event;

    if (messageType === 'price_update' || messageType === 'book') {
      // 验证价格更新消息的必要字段
      if (!this.validatePriceMessage(message)) {
        logger.warn('Invalid price update message structure', {
          hasMarket: 'market' in message || 'asset_id' in message,
          hasBids: 'bids' in message,
          hasAsks: 'asks' in message,
        });
        return;
      }
      this.handlePriceUpdate(message);
    } else if (messageType === 'market_info') {
      // 验证市场信息消息
      if (!this.validateMarketInfoMessage(message)) {
        logger.warn('Invalid market info message structure');
        return;
      }
      this.handleMarketInfo(message);
    } else if (messageType === 'error') {
      // 服务端错误消息
      logger.error('Server error message', {
        errorCode: message.code,
        errorMessage: message.message,
      });
    } else if (messageType === 'subscribed' || messageType === 'unsubscribed') {
      // 订阅确认消息
      logger.debug('Subscription status', { type: messageType, market: message.market });
    } else if (messageType === 'pong' || messageType === 'heartbeat') {
      // 心跳响应
      logger.debug('Heartbeat received');
    } else {
      // 未知消息类型
      logger.debug('Received unknown message type', {
        type: messageType,
        keys: Object.keys(message).slice(0, 10),
      });
    }
  }

  /**
   * 验证价格更新消息结构
   */
  private validatePriceMessage(message: Record<string, unknown>): boolean {
    // 必须有 market/asset_id 或 bids/asks
    const hasMarketId = typeof message.market === 'string' || typeof message.asset_id === 'string';
    const hasOrderbook = Array.isArray(message.bids) || Array.isArray(message.asks);
    const hasPrices = typeof message.up_best_ask === 'number' ||
                      typeof message.up_best_ask === 'string' ||
                      typeof message.down_best_ask === 'number' ||
                      typeof message.down_best_ask === 'string';

    return hasMarketId || hasOrderbook || hasPrices;
  }

  /**
   * 验证市场信息消息结构
   */
  private validateMarketInfoMessage(message: Record<string, unknown>): boolean {
    // 必须有 slug
    return typeof message.slug === 'string' && message.slug.length > 0;
  }

  /**
   * 处理价格更新
   */
  private handlePriceUpdate(data: Record<string, unknown>): void {
    try {
      // 解析价格数据 - 适配 Polymarket CLOB API 格式
      const snapshot: PriceSnapshot = {
        timestamp: Date.now(),
        roundSlug: (data.market as string) || (data.asset_id as string) || '',
        secondsRemaining: data.seconds_remaining as number || 0,
        upTokenId: data.up_token_id as string || '',
        downTokenId: data.down_token_id as string || '',
        upBestAsk: this.parsePrice(data.up_best_ask || (data.asks as unknown[])?.[0]),
        upBestBid: this.parsePrice(data.up_best_bid || (data.bids as unknown[])?.[0]),
        downBestAsk: this.parsePrice(data.down_best_ask),
        downBestBid: this.parsePrice(data.down_best_bid),
      };

      // 如果是 orderbook 格式，从 bids/asks 提取
      if (data.bids && data.asks && Array.isArray(data.bids) && Array.isArray(data.asks)) {
        const bids = data.bids as [string, string][];
        const asks = data.asks as [string, string][];

        if (asks.length > 0) {
          snapshot.upBestAsk = parseFloat(asks[0][0]);
        }
        if (bids.length > 0) {
          snapshot.upBestBid = parseFloat(bids[0][0]);
        }
      }

      // 验证数据有效性
      if (snapshot.upBestAsk > 0 || snapshot.downBestAsk > 0) {
        this.priceBuffer.push(snapshot);
        eventBus.emitEvent('price:update', snapshot);

        logger.debug('Price update received', {
          roundSlug: snapshot.roundSlug,
          upAsk: snapshot.upBestAsk,
          downAsk: snapshot.downBestAsk,
        });
      }

    } catch (error) {
      logger.error('Failed to handle price update', { error, data });
    }
  }

  /**
   * 解析价格值
   */
  private parsePrice(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * 处理市场信息
   */
  private handleMarketInfo(data: Record<string, unknown>): void {
    this.currentMarket = {
      roundSlug: data.slug as string,
      upTokenId: data.up_token_id as string,
      downTokenId: data.down_token_id as string,
      startTime: data.start_time as number,
      endTime: data.end_time as number,
      status: data.status as 'active' | 'resolved' | 'pending',
    };

    logger.info('Market info received', this.currentMarket);
  }

  /**
   * 处理连接关闭
   */
  private handleClose(code: number, reason: string): void {
    this.connectionState = 'disconnected';
    this.stopHeartbeat();

    logger.warn('WebSocket disconnected', { code, reason });
    eventBus.emitEvent('ws:disconnected', { code, reason });

    // 尝试重连
    if (code !== 1000) { // 1000 = 正常关闭
      this.scheduleReconnect();
    }
  }

  /**
   * 处理错误
   */
  private handleError(error: Error): void {
    logger.error('WebSocket error', { error: error.message });
    eventBus.emitEvent('ws:error', error);
  }

  /**
   * 安排重连
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnects) {
      logger.error('Max reconnect attempts reached, giving up');
      eventBus.emitEvent('system:error', new Error('WebSocket max reconnects exceeded'));
      return;
    }

    this.reconnectAttempts++;
    this.connectionState = 'reconnecting';

    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    logger.info(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnects} in ${delay}ms`);

    eventBus.emitEvent('ws:reconnecting', { attempt: this.reconnectAttempts });

    await sleep(delay);

    try {
      await this.connect();
    } catch (error) {
      logger.error('Reconnect failed', { error, attempt: this.reconnectAttempts });
      this.scheduleReconnect();
    }
  }

  /**
   * 启动心跳检测
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.connectionState !== 'connected') {
        return;
      }

      // 检查心跳超时
      if (Date.now() - this.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
        logger.warn('Heartbeat timeout, reconnecting...');
        this.ws.terminate();
        return;
      }

      // 发送 ping
      try {
        this.ws.ping();
        logger.debug('Sent ping to server');
      } catch (error) {
        logger.error('Failed to send ping', { error });
      }

    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * 停止心跳检测
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 订阅市场
   */
  subscribe(tokenId: string): void {
    this.subscriptions.add(tokenId);

    if (this.ws && this.connectionState === 'connected') {
      const message = JSON.stringify({
        type: 'subscribe',
        channel: 'book',
        market: tokenId,
      });

      this.ws.send(message);
      logger.info(`Subscribed to market: ${tokenId}`);
    }
  }

  /**
   * 取消订阅市场
   */
  unsubscribe(tokenId: string): void {
    this.subscriptions.delete(tokenId);

    if (this.ws && this.connectionState === 'connected') {
      const message = JSON.stringify({
        type: 'unsubscribe',
        channel: 'book',
        market: tokenId,
      });

      this.ws.send(message);
      logger.info(`Unsubscribed from market: ${tokenId}`);
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.connectionState = 'disconnected';
    logger.info('WebSocket disconnected by client');
  }

  /**
   * 获取价格缓冲区
   */
  getPriceBuffer(): CircularBuffer<PriceSnapshot> {
    return this.priceBuffer;
  }

  /**
   * 获取最新价格
   */
  getLatestPrice(): PriceSnapshot | undefined {
    return this.priceBuffer.peekLast();
  }

  /**
   * 获取最近的价格数据
   */
  getRecentPrices(milliseconds: number): PriceSnapshot[] {
    return this.priceBuffer.getRecent(milliseconds);
  }

  /**
   * 获取连接状态
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * 获取当前市场信息
   */
  getCurrentMarket(): MarketInfo | null {
    return this.currentMarket;
  }

  /**
   * 获取重连次数
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}

export default MarketWatcher;
