/**
 * 市场发现服务
 * 自动发现和切换 BTC 15 分钟 UP/DOWN 预测市场
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';

/**
 * BTC 15分钟市场信息
 */
export interface Btc15mMarket {
  conditionId: string;
  slug: string;
  question: string;
  upTokenId: string;
  downTokenId: string;
  startTime: number;      // Unix timestamp (ms)
  endTime: number;        // Unix timestamp (ms)
  status: 'active' | 'resolved' | 'pending';
  outcomes: string[];
  outcomePrices: string[];
}

/**
 * Gamma API 市场响应类型
 */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  clobTokenIds?: string[];
  outcomes?: string[];
  outcomePrices?: string[];
  tokens?: Array<{
    token_id: string;
    outcome: string;
  }>;
}

/**
 * Gamma API 搜索响应类型
 */
interface GammaSearchResponse {
  events?: Array<{
    markets?: GammaMarket[];
  }>;
  markets?: GammaMarket[];
}

/**
 * CLOB API 市场响应类型
 */
interface ClobMarket {
  condition_id: string;
  question_id: string;
  question: string;
  description?: string;
  active: boolean;
  closed: boolean;
  enable_order_book: boolean;
  accepting_orders: boolean;
  minimum_order_size: number;
  minimum_tick_size: number;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price?: number;
  }>;
  end_date_iso?: string;
}

/**
 * 市场发现服务配置
 */
export interface MarketDiscoveryConfig {
  gammaApiUrl: string;
  discoveryIntervalMs: number;
  searchKeywords: string[];
  preloadBeforeExpiryMs: number;
}

const DEFAULT_CONFIG: MarketDiscoveryConfig = {
  gammaApiUrl: process.env.GAMMA_API || 'https://gamma-api.polymarket.com',
  discoveryIntervalMs: 10000,  // 10 秒
  searchKeywords: ['bitcoin', 'btc up down', 'btc 15'],
  preloadBeforeExpiryMs: 30000,  // 提前 30 秒预加载
};

export class MarketDiscoveryService {
  private config: MarketDiscoveryConfig;
  private httpClient: AxiosInstance;
  private clobClient: AxiosInstance;  // CLOB API 客户端
  private currentMarket: Btc15mMarket | null = null;
  private nextMarket: Btc15mMarket | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;
  private isDiscovering: boolean = false;
  private lastDiscoveryTime: number = 0;
  private discoveryErrorCount: number = 0;
  private marketCache: Map<string, Btc15mMarket> = new Map();

  constructor(config?: Partial<MarketDiscoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.httpClient = axios.create({
      baseURL: this.config.gammaApiUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // CLOB API 客户端用于通过 condition_id 获取市场信息
    this.clobClient = axios.create({
      baseURL: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    logger.info('MarketDiscoveryService initialized', {
      gammaApiUrl: this.config.gammaApiUrl,
      clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      discoveryIntervalMs: this.config.discoveryIntervalMs,
      searchKeywords: this.config.searchKeywords,
    });
  }

  /**
   * 启动自动发现服务
   */
  start(): void {
    if (this.discoveryInterval) {
      logger.warn('MarketDiscoveryService already running');
      return;
    }

    logger.info('Starting MarketDiscoveryService');

    // 立即执行一次发现
    this.discoverMarkets().catch(error => {
      logger.error('Initial market discovery failed', { error: error.message });
    });

    // 定期发现
    this.discoveryInterval = setInterval(() => {
      this.discoverMarkets().catch(error => {
        logger.error('Periodic market discovery failed', { error: error.message });
      });
    }, this.config.discoveryIntervalMs);
  }

  /**
   * 停止自动发现服务
   */
  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
      logger.info('MarketDiscoveryService stopped');
    }
  }

  /**
   * 发现当前可用的 BTC 15m 市场
   */
  async discoverMarkets(): Promise<Btc15mMarket[]> {
    if (this.isDiscovering) {
      logger.debug('Discovery already in progress, skipping');
      return [];
    }

    this.isDiscovering = true;
    const startTime = Date.now();

    try {
      logger.debug('Starting market discovery', {
        keywords: this.config.searchKeywords,
      });

      const markets: Btc15mMarket[] = [];

      // 搜索多个关键词
      for (const keyword of this.config.searchKeywords) {
        try {
          const results = await this.searchMarkets(keyword);
          for (const market of results) {
            // 避免重复
            if (!markets.find(m => m.conditionId === market.conditionId)) {
              markets.push(market);
            }
          }
        } catch (error) {
          logger.warn(`Search failed for keyword: ${keyword}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 过滤和排序
      const now = Date.now();
      const validMarkets = markets
        .filter(m => m.status === 'active' || (m.status === 'pending' && m.startTime > now))
        .filter(m => m.endTime > now)  // 未过期
        .filter(m => this.isBtc15mMarket(m))  // 确认是 BTC 15m 市场
        .sort((a, b) => a.endTime - b.endTime);  // 按结束时间排序

      logger.info('Market discovery completed', {
        totalFound: markets.length,
        validCount: validMarkets.length,
        duration: Date.now() - startTime,
      });

      // 更新当前和下一个市场
      this.updateCurrentAndNextMarket(validMarkets);

      this.lastDiscoveryTime = Date.now();
      this.discoveryErrorCount = 0;

      return validMarkets;

    } catch (error) {
      this.discoveryErrorCount++;
      logger.error('Market discovery failed', {
        error: error instanceof Error ? error.message : String(error),
        errorCount: this.discoveryErrorCount,
      });
      throw error;
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * 搜索市场
   */
  private async searchMarkets(query: string): Promise<Btc15mMarket[]> {
    try {
      // 尝试 public-search 端点
      const response = await this.httpClient.get<GammaSearchResponse>('/public-search', {
        params: {
          q: query,
          events_status: 'active',
          limit_per_type: 20,
        },
      });

      const markets: Btc15mMarket[] = [];

      // 从 events 中提取市场
      if (response.data.events) {
        for (const event of response.data.events) {
          if (event.markets) {
            for (const market of event.markets) {
              const parsed = this.parseGammaMarket(market);
              if (parsed) {
                markets.push(parsed);
              }
            }
          }
        }
      }

      // 直接从 markets 字段提取
      if (response.data.markets) {
        for (const market of response.data.markets) {
          const parsed = this.parseGammaMarket(market);
          if (parsed) {
            markets.push(parsed);
          }
        }
      }

      logger.debug(`Search results for "${query}"`, { count: markets.length });
      return markets;

    } catch (error) {
      // 如果 public-search 失败，尝试 /markets 端点
      logger.debug('Falling back to /markets endpoint');

      const response = await this.httpClient.get<GammaMarket[]>('/markets', {
        params: {
          active: true,
          limit: 50,
        },
      });

      const markets: Btc15mMarket[] = [];
      const queryLower = query.toLowerCase();

      for (const market of response.data) {
        // 手动过滤匹配的市场
        if (market.question?.toLowerCase().includes(queryLower) ||
            market.slug?.toLowerCase().includes(queryLower)) {
          const parsed = this.parseGammaMarket(market);
          if (parsed) {
            markets.push(parsed);
          }
        }
      }

      return markets;
    }
  }

  /**
   * 解析 Gamma API 市场数据为 Btc15mMarket
   */
  private parseGammaMarket(market: GammaMarket): Btc15mMarket | null {
    try {
      // 检查缓存
      if (this.marketCache.has(market.conditionId)) {
        return this.marketCache.get(market.conditionId)!;
      }

      // 提取 Token IDs
      let upTokenId = '';
      let downTokenId = '';

      if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
        // 通常第一个是 Up，第二个是 Down
        upTokenId = market.clobTokenIds[0];
        downTokenId = market.clobTokenIds[1];
      } else if (market.tokens && market.tokens.length >= 2) {
        for (const token of market.tokens) {
          if (token.outcome.toLowerCase() === 'up') {
            upTokenId = token.token_id;
          } else if (token.outcome.toLowerCase() === 'down') {
            downTokenId = token.token_id;
          }
        }
      }

      if (!upTokenId || !downTokenId) {
        logger.debug('Market missing token IDs', { slug: market.slug });
        return null;
      }

      // 解析时间
      const endTime = market.endDate ? new Date(market.endDate).getTime() : 0;
      if (!endTime) {
        logger.debug('Market missing end date', { slug: market.slug });
        return null;
      }

      // 推算开始时间 (BTC 15m 市场持续 15 分钟)
      const startTime = endTime - 15 * 60 * 1000;

      // 确定状态
      const now = Date.now();
      let status: 'active' | 'resolved' | 'pending';
      if (market.closed) {
        status = 'resolved';
      } else if (now >= startTime && now < endTime) {
        status = 'active';
      } else if (now < startTime) {
        status = 'pending';
      } else {
        status = 'resolved';
      }

      const parsed: Btc15mMarket = {
        conditionId: market.conditionId,
        slug: market.slug,
        question: market.question,
        upTokenId,
        downTokenId,
        startTime,
        endTime,
        status,
        outcomes: market.outcomes || ['Up', 'Down'],
        outcomePrices: market.outcomePrices || ['0.5', '0.5'],
      };

      // 缓存
      this.marketCache.set(market.conditionId, parsed);

      return parsed;

    } catch (error) {
      logger.warn('Failed to parse market', {
        slug: market.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 检查是否是 BTC 15 分钟市场
   */
  private isBtc15mMarket(market: Btc15mMarket): boolean {
    const question = market.question.toLowerCase();
    const slug = market.slug.toLowerCase();

    // 关键词匹配
    const hasBtc = question.includes('bitcoin') || question.includes('btc') || slug.includes('btc');
    const hasUpDown = question.includes('up') && question.includes('down');
    const has15m = question.includes('15') || slug.includes('15m');

    // 时间窗口验证 (应该是 15 分钟)
    const duration = market.endTime - market.startTime;
    const is15Min = duration >= 14 * 60 * 1000 && duration <= 16 * 60 * 1000;

    return hasBtc && hasUpDown && (has15m || is15Min);
  }

  /**
   * 更新当前和下一个市场
   */
  private updateCurrentAndNextMarket(markets: Btc15mMarket[]): void {
    const now = Date.now();
    const oldCurrent = this.currentMarket;

    // 找到当前活跃的市场
    const activeMarket = markets.find(m =>
      m.status === 'active' &&
      now >= m.startTime &&
      now < m.endTime
    );

    // 找到下一个即将开始的市场
    const pendingMarkets = markets.filter(m => m.startTime > now);
    const nextMarket = pendingMarkets.length > 0 ? pendingMarkets[0] : null;

    // 更新当前市场
    if (activeMarket && (!this.currentMarket || this.currentMarket.conditionId !== activeMarket.conditionId)) {
      this.currentMarket = activeMarket;

      logger.info('Current market updated', {
        slug: activeMarket.slug,
        upTokenId: activeMarket.upTokenId.substring(0, 20) + '...',
        downTokenId: activeMarket.downTokenId.substring(0, 20) + '...',
        endTime: new Date(activeMarket.endTime).toISOString(),
      });

      eventBus.emitEvent('market:discovered', activeMarket);

      if (oldCurrent && oldCurrent.conditionId !== activeMarket.conditionId) {
        eventBus.emitEvent('market:switching', {
          from: oldCurrent.slug,
          to: activeMarket.slug,
        } as { from: string; to: string });
      }
    }

    // 更新下一个市场
    if (nextMarket && (!this.nextMarket || this.nextMarket.conditionId !== nextMarket.conditionId)) {
      this.nextMarket = nextMarket;

      logger.info('Next market discovered', {
        slug: nextMarket.slug,
        startTime: new Date(nextMarket.startTime).toISOString(),
      });
    }

    // 检查当前市场是否即将过期
    if (this.currentMarket) {
      const timeToExpiry = this.currentMarket.endTime - now;
      if (timeToExpiry <= this.config.preloadBeforeExpiryMs && this.nextMarket) {
        logger.info('Current market expiring soon, next market ready', {
          currentSlug: this.currentMarket.slug,
          nextSlug: this.nextMarket.slug,
          timeToExpiry,
        });
      }
    }
  }

  /**
   * 获取当前活跃市场
   */
  getCurrentMarket(): Btc15mMarket | null {
    return this.currentMarket;
  }

  /**
   * 获取下一个市场
   */
  getNextMarket(): Btc15mMarket | null {
    return this.nextMarket;
  }

  /**
   * 强制刷新市场信息
   */
  async refresh(): Promise<Btc15mMarket | null> {
    await this.discoverMarkets();
    return this.currentMarket;
  }

  /**
   * 检查是否有可用市场
   */
  hasAvailableMarket(): boolean {
    return this.currentMarket !== null || this.nextMarket !== null;
  }

  /**
   * 获取市场剩余时间 (秒)
   */
  getSecondsRemaining(): number {
    if (!this.currentMarket) return 0;
    const remaining = Math.floor((this.currentMarket.endTime - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  /**
   * 等待下一个市场
   */
  async waitForNextMarket(maxWaitMs: number = 60000): Promise<Btc15mMarket | null> {
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      retryCount++;

      logger.info('Waiting for next market', { retryCount, elapsed: Date.now() - startTime });

      eventBus.emitEvent('market:wait_for_next', { retryCount } as { retryCount: number });

      await this.discoverMarkets();

      if (this.currentMarket) {
        logger.info('Found active market', { slug: this.currentMarket.slug });
        return this.currentMarket;
      }

      if (this.nextMarket) {
        const waitTime = this.nextMarket.startTime - Date.now();
        if (waitTime > 0 && waitTime < maxWaitMs - (Date.now() - startTime)) {
          logger.info(`Waiting for market to start in ${waitTime}ms`);
          await this.sleep(Math.min(waitTime + 1000, 10000));
          continue;
        }
      }

      // 等待后重试
      await this.sleep(this.config.discoveryIntervalMs);
    }

    logger.warn('Timeout waiting for next market', { maxWaitMs });
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取服务状态
   */
  getStatus(): {
    isRunning: boolean;
    currentMarket: string | null;
    nextMarket: string | null;
    lastDiscovery: number;
    errorCount: number;
  } {
    return {
      isRunning: this.discoveryInterval !== null,
      currentMarket: this.currentMarket?.slug || null,
      nextMarket: this.nextMarket?.slug || null,
      lastDiscovery: this.lastDiscoveryTime,
      errorCount: this.discoveryErrorCount,
    };
  }

  /**
   * 通过 Condition ID 获取市场信息
   * 优先使用 CLOB API，因为它可以直接通过 condition_id 获取
   */
  async fetchMarketByConditionId(conditionId: string): Promise<Btc15mMarket | null> {
    if (!conditionId) {
      logger.warn('No conditionId provided');
      return null;
    }

    // 检查缓存
    if (this.marketCache.has(conditionId)) {
      logger.debug('Market found in cache', { conditionId: conditionId.substring(0, 20) + '...' });
      return this.marketCache.get(conditionId)!;
    }

    // 优先使用 CLOB API (直接通过 condition_id 获取)
    try {
      logger.info('Fetching market by conditionId from CLOB API', {
        conditionId: conditionId.substring(0, 20) + '...',
      });

      const response = await this.clobClient.get<ClobMarket>(`/markets/${conditionId}`);
      const market = response.data;

      if (market && market.tokens && market.tokens.length >= 2) {
        const parsed = this.parseClobMarket(market);
        if (parsed) {
          // 缓存结果
          this.marketCache.set(conditionId, parsed);

          logger.info('Market fetched successfully from CLOB API', {
            question: parsed.question,
            upTokenId: parsed.upTokenId.substring(0, 20) + '...',
            downTokenId: parsed.downTokenId.substring(0, 20) + '...',
            endTime: new Date(parsed.endTime).toISOString(),
            status: parsed.status,
          });
          return parsed;
        }
      }
    } catch (error) {
      logger.warn('CLOB API fetch failed, trying Gamma API...', {
        conditionId: conditionId.substring(0, 20) + '...',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback: 尝试 Gamma API
    try {
      const response = await this.httpClient.get<GammaMarket>(`/markets/${conditionId}`);

      if (response.data) {
        const parsed = this.parseGammaMarket(response.data);
        if (parsed) {
          this.marketCache.set(conditionId, parsed);
          logger.info('Market fetched from Gamma API', {
            question: parsed.question,
          });
          return parsed;
        }
      }
    } catch (error) {
      logger.debug('Gamma API fetch also failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.warn('Market not found for conditionId', {
      conditionId: conditionId.substring(0, 20) + '...',
    });
    return null;
  }

  /**
   * 解析 CLOB API 市场数据为 Btc15mMarket
   */
  private parseClobMarket(market: ClobMarket): Btc15mMarket | null {
    try {
      // 提取 Token IDs (根据 outcome 匹配)
      let upTokenId = '';
      let downTokenId = '';

      for (const token of market.tokens || []) {
        const outcome = token.outcome.toLowerCase();
        if (outcome === 'up' || outcome === 'yes') {
          upTokenId = token.token_id;
        } else if (outcome === 'down' || outcome === 'no') {
          downTokenId = token.token_id;
        }
      }

      // 如果没找到 Up/Down，使用第一个和第二个 token
      if (!upTokenId && !downTokenId && market.tokens && market.tokens.length >= 2) {
        upTokenId = market.tokens[0].token_id;
        downTokenId = market.tokens[1].token_id;
      }

      if (!upTokenId || !downTokenId) {
        logger.debug('Market missing token IDs', { question: market.question });
        return null;
      }

      // 解析结束时间
      let endTime = 0;
      if (market.end_date_iso) {
        endTime = new Date(market.end_date_iso).getTime();
      }
      // 如果没有结束时间，从描述中解析或设置默认值
      if (!endTime) {
        // 尝试从描述中解析日期 (如 "Jan 1 '26 12:00 ET")
        const desc = market.description || '';
        const dateMatch = desc.match(/Jan\s+(\d+)\s+'(\d+)\s+(\d+):(\d+)/);
        if (dateMatch) {
          const [, day, year, hour, minute] = dateMatch;
          // 假设是 2026 年
          const fullYear = 2000 + parseInt(year, 10);
          // 创建 ET 时区的时间
          endTime = new Date(`${fullYear}-01-${day.padStart(2, '0')}T${hour}:${minute}:00-05:00`).getTime();
        }
      }
      if (!endTime) {
        // 默认 1 天后
        endTime = Date.now() + 24 * 60 * 60 * 1000;
      }

      // 确定状态
      let status: 'active' | 'resolved' | 'pending';
      if (market.closed) {
        status = 'resolved';
      } else if (market.active && market.accepting_orders) {
        status = 'active';
      } else {
        status = 'pending';
      }

      // 生成 slug
      const slug = market.question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // 从 description 估算开始时间
      let startTime = endTime - 24 * 60 * 60 * 1000;  // 默认假设持续 24 小时
      const startMatch = (market.description || '').match(/Dec\s+(\d+)\s+'(\d+)\s+(\d+):(\d+)/);
      if (startMatch) {
        const [, day, year, hour, minute] = startMatch;
        const fullYear = 2000 + parseInt(year, 10);
        startTime = new Date(`${fullYear}-12-${day.padStart(2, '0')}T${hour}:${minute}:00-05:00`).getTime();
      }

      // 获取价格
      const outcomePrices: string[] = [];
      for (const token of market.tokens || []) {
        outcomePrices.push(token.price?.toString() || '0.5');
      }

      const parsed: Btc15mMarket = {
        conditionId: market.condition_id,
        slug,
        question: market.question,
        upTokenId,
        downTokenId,
        startTime,
        endTime,
        status,
        outcomes: (market.tokens || []).map(t => t.outcome),
        outcomePrices: outcomePrices.length > 0 ? outcomePrices : ['0.5', '0.5'],
      };

      return parsed;

    } catch (error) {
      logger.warn('Failed to parse CLOB market', {
        question: market.question,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export default MarketDiscoveryService;
