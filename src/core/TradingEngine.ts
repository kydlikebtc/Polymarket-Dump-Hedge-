/**
 * 交易引擎
 * 整合所有核心组件，协调完整的交易流程
 */

import { logger, logTrade } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';
import { getAlertManager, type AlertManager } from '../utils/AlertManager.js';
import { MarketWatcher } from '../api/MarketWatcher.js';
import { PolymarketClient } from '../api/PolymarketClient.js';
import { StateMachine } from './StateMachine.js';
import { DumpDetector } from './DumpDetector.js';
import { HedgeStrategy } from './HedgeStrategy.js';
import { RoundManager } from './RoundManager.js';
import { getDatabase } from '../db/Database.js';
import type {
  BotConfig,
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Side,
} from '../types/index.js';

export class TradingEngine {
  private config: BotConfig;
  private marketWatcher: MarketWatcher;
  private client: PolymarketClient;
  private stateMachine: StateMachine;
  private dumpDetector: DumpDetector;
  private hedgeStrategy: HedgeStrategy;
  private roundManager: RoundManager;
  private alertManager: AlertManager;
  private isRunning: boolean = false;
  private isAutoMode: boolean = false;
  private detectionInterval: NodeJS.Timeout | null = null;

  // 检测频率: 约3秒
  private readonly DETECTION_INTERVAL_MS = 3000;

  constructor(config: BotConfig) {
    this.config = config;

    // 初始化组件
    this.marketWatcher = new MarketWatcher(config);
    this.client = new PolymarketClient(config);
    this.stateMachine = new StateMachine();
    this.dumpDetector = new DumpDetector(config);
    this.hedgeStrategy = new HedgeStrategy(config);
    this.roundManager = new RoundManager();
    this.alertManager = getAlertManager();

    // 设置事件监听
    this.setupEventListeners();

    // 设置周期完成回调
    this.stateMachine.setOnCycleComplete((cycle) => {
      this.onCycleComplete(cycle);
    });

    logger.info('TradingEngine initialized', {
      shares: config.shares,
      sumTarget: config.sumTarget,
      movePct: `${config.movePct * 100}%`,
      windowMin: config.windowMin,
      dryRun: config.dryRun,
    });
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // WebSocket 事件
    eventBus.onEvent('ws:connected', () => {
      logger.info('WebSocket connected - subscribing to markets');
      // 订阅当前轮次的市场 (如果有)
      this.subscribeToCurrentMarket();
    });

    eventBus.onEvent('ws:disconnected', ({ code, reason }) => {
      logger.warn('WebSocket disconnected', { code, reason });
      this.stopDetection();
      // 发送告警
      this.alertManager.alertWebSocketDisconnected(code, reason);
    });

    // 价格更新事件
    eventBus.onEvent('price:update', (snapshot: PriceSnapshot) => {
      this.onPriceUpdate(snapshot);
    });

    // 轮次事件
    eventBus.onEvent('round:new', ({ roundSlug, startTime }) => {
      this.onNewRound(roundSlug, startTime);
    });

    eventBus.onEvent('round:expired', () => {
      this.onRoundExpired();
    });
  }

  /**
   * 启动引擎
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Engine already running');
      return;
    }

    logger.info('Starting trading engine...');
    this.isRunning = true;

    try {
      // 连接 WebSocket
      await this.marketWatcher.connect();

      // 启动轮次检查
      this.roundManager.startPeriodicCheck();

      logger.info('Trading engine started successfully');

    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start trading engine', { error });
      throw error;
    }
  }

  /**
   * 停止引擎
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping trading engine...');

    this.isAutoMode = false;
    this.stopDetection();
    this.roundManager.stopPeriodicCheck();
    this.marketWatcher.disconnect();

    this.isRunning = false;
    logger.info('Trading engine stopped');
  }

  /**
   * 启动自动交易模式
   */
  startAutoMode(): void {
    if (!this.isRunning) {
      throw new Error('Engine not running. Call start() first.');
    }

    if (this.isAutoMode) {
      logger.warn('Auto mode already active');
      return;
    }

    this.isAutoMode = true;
    this.startDetection();

    logger.info('Auto trading mode started', {
      shares: this.config.shares,
      sumTarget: this.config.sumTarget,
      movePct: `${this.config.movePct * 100}%`,
      windowMin: this.config.windowMin,
    });

    logTrade('auto_mode_started', {
      shares: this.config.shares,
      sumTarget: this.config.sumTarget,
      movePct: this.config.movePct,
      windowMin: this.config.windowMin,
    });
  }

  /**
   * 停止自动交易模式
   */
  stopAutoMode(): void {
    if (!this.isAutoMode) {
      return;
    }

    this.isAutoMode = false;
    this.stopDetection();

    logger.info('Auto trading mode stopped');
    logTrade('auto_mode_stopped', {});
  }

  /**
   * 启动暴跌检测循环
   */
  private startDetection(): void {
    this.stopDetection();

    this.detectionInterval = setInterval(() => {
      this.runDetectionCycle();
    }, this.DETECTION_INTERVAL_MS);

    logger.debug('Detection loop started', { interval: this.DETECTION_INTERVAL_MS });
  }

  /**
   * 停止暴跌检测循环
   */
  private stopDetection(): void {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
  }

  /**
   * 执行一次检测周期
   */
  private runDetectionCycle(): void {
    if (!this.isAutoMode || !this.roundManager.isRoundActive()) {
      return;
    }

    const currentStatus = this.stateMachine.getCurrentStatus();

    // 状态: WATCHING - 检测暴跌
    if (currentStatus === 'WATCHING') {
      const roundSlug = this.roundManager.getCurrentRoundSlug();
      if (roundSlug) {
        const signal = this.dumpDetector.detect(
          this.marketWatcher.getPriceBuffer(),
          roundSlug
        );

        if (signal) {
          this.executeLeg1(signal);
        }
      }
    }

    // 状态: LEG1_FILLED - 检测对冲条件
    if (currentStatus === 'LEG1_FILLED') {
      this.checkHedgeCondition();
    }
  }

  /**
   * 执行 Leg 1 (买入暴跌方)
   */
  private async executeLeg1(signal: DumpSignal): Promise<void> {
    logger.info('Executing Leg 1...', {
      side: signal.side,
      price: signal.price,
      shares: this.config.shares,
    });

    // 通知状态机
    this.stateMachine.onDumpDetected(signal);

    // 发送暴跌检测告警
    this.alertManager.alertDumpDetected(signal);

    // 锁定检测方向
    this.dumpDetector.lockSide(signal.side);

    try {
      // 获取 Token ID
      const tokenId = this.roundManager.getTokenId(signal.side);
      if (!tokenId) {
        throw new Error(`No token ID for ${signal.side}`);
      }

      // 执行买入
      const result = await this.client.buyByShares(
        signal.side,
        tokenId,
        this.config.shares,
        signal.price
      );

      if (result.status === 'filled' || result.status === 'partial') {
        this.stateMachine.onLeg1Filled(result);

        // 保存到数据库
        const cycle = this.stateMachine.getCurrentCycle();
        if (cycle) {
          getDatabase().createTradeCycle(cycle);
        }
      } else {
        const errorMsg = `Leg 1 order failed: ${result.error || 'Unknown error'}`;
        this.alertManager.alertOrderFailed(signal.side, errorMsg);
        throw new Error(errorMsg);
      }

    } catch (error) {
      logger.error('Leg 1 execution failed', { error });
      this.stateMachine.onError(error as Error);
      this.alertManager.alertSystemError(error as Error);
    }
  }

  /**
   * 检查对冲条件
   */
  private async checkHedgeCondition(): Promise<void> {
    const leg1 = this.stateMachine.getLeg1();
    if (!leg1) {
      return;
    }

    const currentPrice = this.marketWatcher.getLatestPrice();
    if (!currentPrice) {
      return;
    }

    const hedgeCalc = this.hedgeStrategy.calculateHedge(leg1, currentPrice);

    if (hedgeCalc.shouldHedge) {
      logger.info('Hedge condition met!', {
        currentSum: hedgeCalc.currentSum,
        targetSum: hedgeCalc.targetSum,
        potentialProfit: hedgeCalc.potentialProfit,
      });

      await this.executeLeg2(leg1, hedgeCalc.oppositePrice);
    }
  }

  /**
   * 执行 Leg 2 (对冲)
   */
  private async executeLeg2(leg1: { side: Side; entryPrice: number; shares: number }, oppositePrice: number): Promise<void> {
    const leg2Side: Side = leg1.side === 'UP' ? 'DOWN' : 'UP';

    logger.info('Executing Leg 2 (hedge)...', {
      side: leg2Side,
      price: oppositePrice,
      shares: this.config.shares,
    });

    this.stateMachine.onLeg2Started();

    try {
      // 获取 Token ID
      const tokenId = this.roundManager.getTokenId(leg2Side);
      if (!tokenId) {
        throw new Error(`No token ID for ${leg2Side}`);
      }

      // 执行买入
      const result = await this.client.buyByShares(
        leg2Side,
        tokenId,
        this.config.shares,
        oppositePrice
      );

      if (result.status === 'filled' || result.status === 'partial') {
        this.stateMachine.onLeg2Filled(result);

        // 更新数据库
        const cycle = this.stateMachine.getCurrentCycle();
        if (cycle) {
          getDatabase().updateTradeCycle(cycle);
        }
      } else {
        const errorMsg = `Leg 2 order failed: ${result.error || 'Unknown error'}`;
        this.alertManager.alertOrderFailed(leg2Side, errorMsg);
        throw new Error(errorMsg);
      }

    } catch (error) {
      logger.error('Leg 2 execution failed', { error });
      this.stateMachine.onError(error as Error);
      this.alertManager.alertSystemError(error as Error);
    }
  }

  /**
   * 处理价格更新
   */
  private onPriceUpdate(snapshot: PriceSnapshot): void {
    // 更新轮次管理器
    this.roundManager.updateFromSnapshot(snapshot);

    // 记录价格到数据库 (可选，高频数据)
    // getDatabase().savePriceSnapshot(snapshot);
  }

  /**
   * 处理新轮次
   */
  private onNewRound(roundSlug: string, startTime: number): void {
    logger.info('New round detected', { roundSlug, startTime });

    // 重置检测器
    this.dumpDetector.setRoundStartTime(startTime);
    this.dumpDetector.unlock();

    // 重置状态机
    this.stateMachine.reset();

    // 如果在自动模式，开始新周期
    if (this.isAutoMode) {
      this.stateMachine.startNewCycle(roundSlug);
    }

    // 订阅新市场
    this.subscribeToCurrentMarket();
  }

  /**
   * 处理轮次过期
   */
  private onRoundExpired(): void {
    logger.info('Round expired');

    // 检查是否有未对冲的 Leg1
    const cycle = this.stateMachine.getCurrentCycle();
    if (cycle && cycle.leg1 && !cycle.leg2) {
      // 计算损失并发送告警
      const loss = -(cycle.leg1.totalCost);
      this.alertManager.alertRoundExpiredWithLoss(cycle, loss);
    }

    // 通知状态机
    this.stateMachine.onRoundExpired();

    // 更新数据库
    if (cycle) {
      getDatabase().updateTradeCycle(cycle);
    }

    // 重置状态机
    this.stateMachine.reset();
  }

  /**
   * 周期完成回调
   */
  private onCycleComplete(cycle: TradeCycle): void {
    logger.info('Trade cycle completed', {
      cycleId: cycle.id,
      profit: cycle.profit,
      leg1: cycle.leg1,
      leg2: cycle.leg2,
    });

    // 发送交易完成告警
    if (cycle.profit !== undefined) {
      this.alertManager.alertTradeCompleted(cycle, cycle.profit);
    }

    // 更新数据库
    getDatabase().updateTradeCycle(cycle);

    // 重置状态机准备下一次
    this.stateMachine.reset();
  }

  /**
   * 订阅当前市场
   */
  private subscribeToCurrentMarket(): void {
    const upToken = this.roundManager.getUpTokenId();
    const downToken = this.roundManager.getDownTokenId();

    if (upToken) {
      this.marketWatcher.subscribe(upToken);
    }
    if (downToken) {
      this.marketWatcher.subscribe(downToken);
    }
  }

  /**
   * 手动买入
   */
  async manualBuy(side: Side, amount: number, isShares: boolean = false): Promise<void> {
    const tokenId = this.roundManager.getTokenId(side);
    if (!tokenId) {
      throw new Error('No active market');
    }

    const currentPrice = this.marketWatcher.getLatestPrice();
    const price = side === 'UP' ? currentPrice?.upBestAsk : currentPrice?.downBestAsk;

    if (!price) {
      throw new Error('No price available');
    }

    if (isShares) {
      await this.client.buyByShares(side, tokenId, amount, price);
    } else {
      await this.client.buyByUsd(side, tokenId, amount);
    }
  }

  // ===== Getters =====

  isEngineRunning(): boolean {
    return this.isRunning;
  }

  isInAutoMode(): boolean {
    return this.isAutoMode;
  }

  getStateMachine(): StateMachine {
    return this.stateMachine;
  }

  getMarketWatcher(): MarketWatcher {
    return this.marketWatcher;
  }

  getRoundManager(): RoundManager {
    return this.roundManager;
  }

  getDumpDetector(): DumpDetector {
    return this.dumpDetector;
  }

  getHedgeStrategy(): HedgeStrategy {
    return this.hedgeStrategy;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  /**
   * 更新配置参数
   */
  updateConfig(params: Partial<{
    shares: number;
    sumTarget: number;
    movePct: number;
    windowMin: number;
  }>): void {
    if (params.shares !== undefined) {
      this.config.shares = params.shares;
    }
    if (params.sumTarget !== undefined) {
      this.config.sumTarget = params.sumTarget;
      this.hedgeStrategy.updateConfig(params.sumTarget);
    }
    if (params.movePct !== undefined) {
      this.config.movePct = params.movePct;
      this.dumpDetector.updateConfig(params.movePct);
    }
    if (params.windowMin !== undefined) {
      this.config.windowMin = params.windowMin;
      this.dumpDetector.updateConfig(undefined, params.windowMin);
    }

    logger.info('Config updated', params);
  }
}

export default TradingEngine;
