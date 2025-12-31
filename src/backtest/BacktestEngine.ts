/**
 * 回测引擎
 * 使用历史价格数据回放模拟策略执行
 */

import { logger } from '../utils/logger.js';
import { CircularBuffer } from '../utils/CircularBuffer.js';
import { getDatabase } from '../db/Database.js';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  PriceSnapshot,
  TradeCycle,
  DumpSignal,
  Side,
} from '../types/index.js';

interface VirtualLeg {
  side: Side;
  shares: number;
  price: number;
  cost: number;
  filledAt: number;
}

interface VirtualCycle {
  id: string;
  roundSlug: string;
  status: 'WATCHING' | 'LEG1_FILLED' | 'COMPLETED' | 'EXPIRED';
  leg1?: VirtualLeg;
  leg2?: VirtualLeg;
  profit?: number;
  startTime: number;
  endTime?: number;
}

export class BacktestEngine {
  private config: BacktestConfig;
  private priceData: PriceSnapshot[] = [];
  private trades: VirtualCycle[] = [];
  private equityCurve: { timestamp: number; equity: number }[] = [];

  private currentEquity: number;
  private peakEquity: number;
  private currentCycle: VirtualCycle | null = null;
  private priceBuffer: CircularBuffer<PriceSnapshot>;
  private roundStartTime: number = 0;
  private lockedSide: Side | null = null;

  // 检测配置
  private readonly DETECTION_WINDOW_SECONDS = 3;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.currentEquity = config.initialCapital;
    this.peakEquity = config.initialCapital;
    this.priceBuffer = new CircularBuffer<PriceSnapshot>(100);

    logger.info('BacktestEngine initialized', {
      startTime: new Date(config.startTime).toISOString(),
      endTime: new Date(config.endTime).toISOString(),
      initialCapital: config.initialCapital,
      shares: config.shares,
      sumTarget: config.sumTarget,
      movePct: `${config.movePct * 100}%`,
      windowMin: config.windowMin,
    });
  }

  /**
   * 加载历史价格数据
   */
  loadData(data?: PriceSnapshot[]): void {
    if (data) {
      this.priceData = data;
    } else {
      // 从数据库加载
      this.priceData = getDatabase().getPriceSnapshots(
        this.config.startTime,
        this.config.endTime
      );
    }

    logger.info(`Loaded ${this.priceData.length} price snapshots for backtest`, {
      startTime: new Date(this.config.startTime).toISOString(),
      endTime: new Date(this.config.endTime).toISOString(),
    });

    if (this.priceData.length === 0) {
      logger.warn('No price data found for the specified time range');
    }
  }

  /**
   * 运行回测
   */
  run(): BacktestResult {
    logger.info('Starting backtest...');

    this.reset();

    let currentRound = '';
    let processedCount = 0;

    for (const snapshot of this.priceData) {
      processedCount++;

      // 检测新轮次
      if (snapshot.roundSlug !== currentRound) {
        this.handleNewRound(snapshot.roundSlug, snapshot.timestamp);
        currentRound = snapshot.roundSlug;
      }

      // 更新价格缓冲
      this.priceBuffer.push(snapshot);

      // 检测轮次过期
      if (snapshot.secondsRemaining <= 0) {
        this.handleRoundExpired();
        continue;
      }

      // 运行策略逻辑
      this.processSnapshot(snapshot);

      // 记录权益曲线 (每100个数据点)
      if (processedCount % 100 === 0) {
        this.equityCurve.push({
          timestamp: snapshot.timestamp,
          equity: this.currentEquity,
        });
      }
    }

    // 确保最后一个数据点被记录
    if (this.priceData.length > 0) {
      this.equityCurve.push({
        timestamp: this.priceData[this.priceData.length - 1].timestamp,
        equity: this.currentEquity,
      });
    }

    // 计算指标
    const metrics = this.calculateMetrics();

    logger.info('Backtest completed', {
      totalTrades: metrics.totalTrades,
      netProfit: metrics.netProfit,
      winRate: `${(metrics.winRate * 100).toFixed(1)}%`,
      maxDrawdown: `${(metrics.maxDrawdownPct * 100).toFixed(2)}%`,
      returnPct: `${(metrics.returnPct * 100).toFixed(2)}%`,
    });

    return {
      config: this.config,
      trades: this.trades.map(this.convertToTradeCycle),
      metrics,
      equityCurve: this.equityCurve,
    };
  }

  /**
   * 重置回测状态
   */
  private reset(): void {
    this.trades = [];
    this.equityCurve = [];
    this.currentEquity = this.config.initialCapital;
    this.peakEquity = this.config.initialCapital;
    this.currentCycle = null;
    this.priceBuffer.clear();
    this.roundStartTime = 0;
    this.lockedSide = null;

    // 记录初始权益
    this.equityCurve.push({
      timestamp: this.config.startTime,
      equity: this.currentEquity,
    });
  }

  /**
   * 处理价格快照
   */
  private processSnapshot(snapshot: PriceSnapshot): void {
    if (!this.currentCycle) {
      return;
    }

    // 状态: WATCHING - 检测暴跌
    if (this.currentCycle.status === 'WATCHING') {
      const signal = this.detectDump(snapshot.roundSlug);
      if (signal) {
        this.executeLeg1(signal, snapshot);
      }
    }

    // 状态: LEG1_FILLED - 检测对冲条件
    if (this.currentCycle.status === 'LEG1_FILLED') {
      this.checkHedgeCondition(snapshot);
    }
  }

  /**
   * 检测暴跌
   */
  private detectDump(roundSlug: string): DumpSignal | null {
    // Note: using buffer timestamp instead of Date.now() for accurate backtest simulation

    // 检查是否在监控窗口内
    const elapsedMs = this.priceBuffer.peekLast()?.timestamp
      ? this.priceBuffer.peekLast()!.timestamp - this.roundStartTime
      : 0;

    if (elapsedMs > this.config.windowMin * 60 * 1000) {
      return null; // 超出监控窗口
    }

    // 获取窗口内价格
    const windowPrices = this.priceBuffer.getRecent(
      this.DETECTION_WINDOW_SECONDS * 1000
    );

    if (windowPrices.length < 2) {
      return null;
    }

    const first = windowPrices[0];
    const last = windowPrices[windowPrices.length - 1];

    // 检测 UP 暴跌
    if (this.lockedSide !== 'UP' && first.upBestAsk > 0) {
      const upDrop = (first.upBestAsk - last.upBestAsk) / first.upBestAsk;
      if (upDrop >= this.config.movePct) {
        return {
          side: 'UP',
          dropPct: upDrop,
          price: last.upBestAsk,
          previousPrice: first.upBestAsk,
          timestamp: last.timestamp,
          roundSlug,
        };
      }
    }

    // 检测 DOWN 暴跌
    if (this.lockedSide !== 'DOWN' && first.downBestAsk > 0) {
      const downDrop = (first.downBestAsk - last.downBestAsk) / first.downBestAsk;
      if (downDrop >= this.config.movePct) {
        return {
          side: 'DOWN',
          dropPct: downDrop,
          price: last.downBestAsk,
          previousPrice: first.downBestAsk,
          timestamp: last.timestamp,
          roundSlug,
        };
      }
    }

    return null;
  }

  /**
   * 执行虚拟 Leg 1
   */
  private executeLeg1(signal: DumpSignal, snapshot: PriceSnapshot): void {
    if (!this.currentCycle) return;

    const cost = signal.price * this.config.shares;

    // 检查余额
    if (cost > this.currentEquity) {
      logger.debug('Insufficient balance for Leg 1', {
        required: cost,
        available: this.currentEquity,
      });
      return;
    }

    this.currentCycle.status = 'LEG1_FILLED';
    this.currentCycle.leg1 = {
      side: signal.side,
      shares: this.config.shares,
      price: signal.price,
      cost,
      filledAt: snapshot.timestamp,
    };

    this.lockedSide = signal.side;

    logger.debug('Virtual Leg 1 executed', {
      cycleId: this.currentCycle.id,
      side: signal.side,
      price: signal.price,
      cost,
    });
  }

  /**
   * 检查对冲条件
   */
  private checkHedgeCondition(snapshot: PriceSnapshot): void {
    if (!this.currentCycle?.leg1) return;

    const leg1 = this.currentCycle.leg1;
    const oppositePrice = leg1.side === 'UP'
      ? snapshot.downBestAsk
      : snapshot.upBestAsk;

    const sum = leg1.price + oppositePrice;

    if (sum <= this.config.sumTarget) {
      this.executeLeg2(oppositePrice, snapshot);
    }
  }

  /**
   * 执行虚拟 Leg 2
   */
  private executeLeg2(oppositePrice: number, snapshot: PriceSnapshot): void {
    if (!this.currentCycle?.leg1) return;

    const leg1 = this.currentCycle.leg1;
    const leg2Side: Side = leg1.side === 'UP' ? 'DOWN' : 'UP';
    const cost = oppositePrice * this.config.shares;

    // 检查余额
    if (leg1.cost + cost > this.currentEquity) {
      logger.debug('Insufficient balance for Leg 2', {
        required: leg1.cost + cost,
        available: this.currentEquity,
      });
      return;
    }

    this.currentCycle.leg2 = {
      side: leg2Side,
      shares: this.config.shares,
      price: oppositePrice,
      cost,
      filledAt: snapshot.timestamp,
    };

    // 计算收益
    const totalCost = leg1.cost + cost;
    const guaranteedReturn = 1.0 * this.config.shares;
    const grossProfit = guaranteedReturn - totalCost;
    const fees = totalCost * this.config.feeRate;
    const netProfit = grossProfit - fees;

    this.currentCycle.profit = netProfit;
    this.currentCycle.status = 'COMPLETED';
    this.currentCycle.endTime = snapshot.timestamp;

    // 更新权益
    this.currentEquity += netProfit;
    this.updatePeakEquity();

    logger.debug('Virtual cycle completed', {
      cycleId: this.currentCycle.id,
      leg1Price: leg1.price,
      leg2Price: oppositePrice,
      profit: netProfit,
    });

    // 保存交易
    this.trades.push({ ...this.currentCycle });

    // 重置周期
    this.currentCycle = null;
  }

  /**
   * 处理新轮次
   */
  private handleNewRound(roundSlug: string, timestamp: number): void {
    // 处理未完成的周期
    if (this.currentCycle && this.currentCycle.status !== 'COMPLETED') {
      this.handleRoundExpired();
    }

    this.roundStartTime = timestamp;
    this.lockedSide = null;
    this.priceBuffer.clear();

    // 开始新周期
    this.currentCycle = {
      id: `bt-${timestamp}-${Math.random().toString(36).substr(2, 6)}`,
      roundSlug,
      status: 'WATCHING',
      startTime: timestamp,
    };

    logger.debug('New backtest round', { roundSlug, timestamp });
  }

  /**
   * 处理轮次过期
   */
  private handleRoundExpired(): void {
    if (!this.currentCycle) return;

    // 如果有未对冲的 Leg 1，记录损失
    if (this.currentCycle.status === 'LEG1_FILLED' && this.currentCycle.leg1) {
      this.currentCycle.status = 'EXPIRED';
      this.currentCycle.profit = -this.currentCycle.leg1.cost;
      this.currentCycle.endTime = Date.now();

      // 更新权益
      this.currentEquity += this.currentCycle.profit;
      this.updatePeakEquity();

      logger.debug('Cycle expired with loss', {
        cycleId: this.currentCycle.id,
        loss: this.currentCycle.profit,
      });

      this.trades.push({ ...this.currentCycle });
    }

    this.currentCycle = null;
  }

  /**
   * 更新峰值权益
   */
  private updatePeakEquity(): void {
    if (this.currentEquity > this.peakEquity) {
      this.peakEquity = this.currentEquity;
    }
  }

  /**
   * 计算回测指标
   */
  private calculateMetrics(): BacktestMetrics {
    const completedTrades = this.trades.filter(t => t.status === 'COMPLETED' || t.status === 'EXPIRED');
    const winningTrades = completedTrades.filter(t => (t.profit || 0) > 0);
    const losingTrades = completedTrades.filter(t => (t.profit || 0) < 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.profit || 0), 0));
    const netProfit = totalProfit - totalLoss;

    // 计算最大回撤
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let peak = this.config.initialCapital;

    for (const point of this.equityCurve) {
      if (point.equity > peak) {
        peak = point.equity;
      }
      const drawdown = peak - point.equity;
      const drawdownPct = peak > 0 ? drawdown / peak : 0;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
      }
    }

    // 计算夏普比率 (简化版)
    const returns = this.calculateDailyReturns();
    const avgReturn = returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length
      : 0;
    const stdReturn = this.standardDeviation(returns);
    const sharpeRatio = stdReturn > 0 ? (avgReturn * Math.sqrt(365)) / stdReturn : 0;

    // 收益因子
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    return {
      totalTrades: completedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: completedTrades.length > 0
        ? winningTrades.length / completedTrades.length
        : 0,
      totalProfit,
      totalLoss,
      netProfit,
      maxDrawdown,
      maxDrawdownPct,
      sharpeRatio,
      profitFactor,
      avgWin: winningTrades.length > 0
        ? totalProfit / winningTrades.length
        : 0,
      avgLoss: losingTrades.length > 0
        ? totalLoss / losingTrades.length
        : 0,
      avgTrade: completedTrades.length > 0
        ? netProfit / completedTrades.length
        : 0,
      finalEquity: this.currentEquity,
      returnPct: (this.currentEquity - this.config.initialCapital) / this.config.initialCapital,
    };
  }

  /**
   * 计算日收益率
   */
  private calculateDailyReturns(): number[] {
    const returns: number[] = [];
    const dailyEquity: Map<string, number> = new Map();

    // 按天聚合权益
    for (const point of this.equityCurve) {
      const day = new Date(point.timestamp).toISOString().split('T')[0];
      dailyEquity.set(day, point.equity);
    }

    // 计算日收益率
    const days = Array.from(dailyEquity.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < days.length; i++) {
      const prevEquity = days[i - 1][1];
      const currEquity = days[i][1];
      if (prevEquity > 0) {
        returns.push((currEquity - prevEquity) / prevEquity);
      }
    }

    return returns;
  }

  /**
   * 计算标准差
   */
  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  /**
   * 转换为 TradeCycle 格式
   */
  private convertToTradeCycle(cycle: VirtualCycle): TradeCycle {
    return {
      id: cycle.id,
      roundSlug: cycle.roundSlug,
      status: cycle.status === 'COMPLETED' ? 'COMPLETED'
        : cycle.status === 'EXPIRED' ? 'ROUND_EXPIRED'
        : 'WATCHING',
      leg1: cycle.leg1 ? {
        orderId: `bt-${cycle.leg1.filledAt}`,
        side: cycle.leg1.side,
        shares: cycle.leg1.shares,
        entryPrice: cycle.leg1.price,
        totalCost: cycle.leg1.cost,
        filledAt: cycle.leg1.filledAt,
      } : undefined,
      leg2: cycle.leg2 ? {
        orderId: `bt-${cycle.leg2.filledAt}`,
        side: cycle.leg2.side,
        shares: cycle.leg2.shares,
        entryPrice: cycle.leg2.price,
        totalCost: cycle.leg2.cost,
        filledAt: cycle.leg2.filledAt,
      } : undefined,
      profit: cycle.profit,
      createdAt: cycle.startTime,
      updatedAt: cycle.endTime || cycle.startTime,
    };
  }
}

export default BacktestEngine;
