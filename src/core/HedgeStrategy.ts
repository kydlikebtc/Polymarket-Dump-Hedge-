/**
 * 对冲策略模块
 * 计算对冲条件和收益
 */

import { logger, logTrade } from '../utils/logger.js';
import type { CircularBuffer } from '../utils/CircularBuffer.js';
import type {
  BotConfig,
  PriceSnapshot,
  Side,
  LegInfo,
} from '../types/index.js';

/**
 * 对冲概率预判结果
 */
export interface HedgeProbabilityResult {
  probability: number;           // 预判概率 (0-1)
  confidence: number;            // 置信度 (0-1)
  expectedTimeToHedge: number;   // 预估对冲时间 (毫秒)
  recommendation: 'enter' | 'wait' | 'skip';  // 建议操作
  factors: {
    priceVolatility: number;     // 价格波动率
    trendDirection: number;      // 趋势方向 (-1 到 1)
    spreadHealth: number;        // 价差健康度
    timeRemaining: number;       // 轮次剩余时间影响
  };
  reason: string;                // 决策原因说明
}

export interface HedgeCalculation {
  shouldHedge: boolean;
  currentSum: number;
  targetSum: number;
  oppositePrice: number;
  leg1Price: number;
  potentialProfit: number;
  profitPct: number;
}

export class HedgeStrategy {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;

    logger.info('HedgeStrategy initialized', {
      sumTarget: config.sumTarget,
      shares: config.shares,
      feeRate: config.feeRate,
    });
  }

  /**
   * 检查是否满足对冲条件
   *
   * 对冲条件: leg1EntryPrice + oppositeAsk <= sumTarget
   *
   * 例如: 买入 UP @ 0.40, 当 DOWN ask <= 0.55 时
   *       对冲: 0.40 + 0.55 = 0.95 <= 0.95 (满足)
   *       保证收益: $1.00 - $0.95 = $0.05/share
   */
  shouldHedge(leg1Price: number, oppositeAsk: number): boolean {
    const sum = leg1Price + oppositeAsk;
    return sum <= this.config.sumTarget;
  }

  /**
   * 计算对冲详情
   */
  calculateHedge(
    leg1: LegInfo,
    currentPrice: PriceSnapshot
  ): HedgeCalculation {
    const oppositeSide = leg1.side === 'UP' ? 'DOWN' : 'UP';
    const oppositePrice =
      oppositeSide === 'UP' ? currentPrice.upBestAsk : currentPrice.downBestAsk;

    const currentSum = leg1.entryPrice + oppositePrice;
    const shouldHedge = currentSum <= this.config.sumTarget;

    // 计算潜在收益 (不考虑手续费)
    const grossProfit = shouldHedge
      ? (1.0 - currentSum) * leg1.shares
      : 0;

    // 计算手续费
    const leg1Fee = leg1.totalCost * this.config.feeRate;
    const leg2Fee = oppositePrice * leg1.shares * this.config.feeRate;
    const totalFees = leg1Fee + leg2Fee;

    // 净收益
    const potentialProfit = grossProfit - totalFees;
    const profitPct = leg1.totalCost > 0
      ? potentialProfit / leg1.totalCost
      : 0;

    return {
      shouldHedge,
      currentSum,
      targetSum: this.config.sumTarget,
      oppositePrice,
      leg1Price: leg1.entryPrice,
      potentialProfit,
      profitPct,
    };
  }

  /**
   * 计算保证收益 (双腿完成后)
   *
   * 无论 UP 还是 DOWN 最终胜出，我们都持有一个会变成 $1.00 的 token
   * 保证收益 = $1.00 * shares - (leg1Cost + leg2Cost)
   */
  calculateGuaranteedProfit(
    leg1Price: number,
    leg2Price: number,
    shares: number
  ): {
    grossProfit: number;
    fees: number;
    netProfit: number;
  } {
    const totalCost = (leg1Price + leg2Price) * shares;
    const guaranteedReturn = 1.0 * shares;
    const grossProfit = guaranteedReturn - totalCost;

    // 估算手续费
    const fees = totalCost * this.config.feeRate * 2; // 双腿

    return {
      grossProfit,
      fees,
      netProfit: grossProfit - fees,
    };
  }

  /**
   * 计算最大可接受的 Leg 2 价格
   */
  getMaxLeg2Price(leg1Price: number): number {
    return this.config.sumTarget - leg1Price;
  }

  /**
   * 计算盈亏平衡的 sumTarget
   */
  getBreakEvenSum(leg1Price: number, leg2Price: number): number {
    // 考虑手续费的盈亏平衡点
    const totalCost = leg1Price + leg2Price;
    const feeAdjustment = totalCost * this.config.feeRate * 2;
    return totalCost + feeAdjustment / this.config.shares;
  }

  /**
   * 模拟对冲结果
   */
  simulateHedge(
    leg1Side: Side,
    leg1Price: number,
    leg2Price: number,
    shares: number
  ): {
    leg1: { side: Side; price: number; cost: number };
    leg2: { side: Side; price: number; cost: number };
    totalCost: number;
    guaranteedReturn: number;
    grossProfit: number;
    fees: number;
    netProfit: number;
    profitPct: number;
  } {
    const leg2Side: Side = leg1Side === 'UP' ? 'DOWN' : 'UP';

    const leg1Cost = leg1Price * shares;
    const leg2Cost = leg2Price * shares;
    const totalCost = leg1Cost + leg2Cost;
    const guaranteedReturn = 1.0 * shares;
    const grossProfit = guaranteedReturn - totalCost;

    // 手续费: 买入Leg1 + 买入Leg2 (每笔交易都收取)
    const leg1Fee = leg1Cost * this.config.feeRate;
    const leg2Fee = leg2Cost * this.config.feeRate;
    const fees = leg1Fee + leg2Fee;
    const netProfit = grossProfit - fees;
    const profitPct = totalCost > 0 ? netProfit / totalCost : 0;

    const result = {
      leg1: { side: leg1Side, price: leg1Price, cost: leg1Cost },
      leg2: { side: leg2Side, price: leg2Price, cost: leg2Cost },
      totalCost,
      guaranteedReturn,
      grossProfit,
      fees,
      netProfit,
      profitPct,
    };

    logger.debug('Hedge simulation', result);

    return result;
  }

  /**
   * 获取当前配置
   */
  getConfig(): { sumTarget: number; shares: number; feeRate: number } {
    return {
      sumTarget: this.config.sumTarget,
      shares: this.config.shares,
      feeRate: this.config.feeRate,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(sumTarget?: number, shares?: number): void {
    if (sumTarget !== undefined) {
      if (sumTarget < 0.5 || sumTarget > 1.0) {
        throw new Error('sumTarget must be between 0.5 and 1.0');
      }
      this.config.sumTarget = sumTarget;
    }

    if (shares !== undefined) {
      if (shares <= 0) {
        throw new Error('shares must be positive');
      }
      this.config.shares = shares;
    }

    logger.info('HedgeStrategy config updated', {
      sumTarget: this.config.sumTarget,
      shares: this.config.shares,
    });
  }

  /**
   * 记录对冲执行
   */
  logHedgeExecution(
    leg1: LegInfo,
    leg2: LegInfo,
    profit: number
  ): void {
    logTrade('hedge_executed', {
      leg1Side: leg1.side,
      leg1Price: leg1.entryPrice,
      leg1Shares: leg1.shares,
      leg2Side: leg2.side,
      leg2Price: leg2.entryPrice,
      leg2Shares: leg2.shares,
      totalCost: leg1.totalCost + leg2.totalCost,
      guaranteedProfit: profit,
    });
  }

  /**
   * 获取对冲状态描述
   */
  getHedgeStatus(
    leg1: LegInfo | undefined,
    currentPrice: PriceSnapshot
  ): string {
    if (!leg1) {
      return 'No active position';
    }

    const calc = this.calculateHedge(leg1, currentPrice);

    if (calc.shouldHedge) {
      return `READY TO HEDGE! Sum=${calc.currentSum.toFixed(4)} <= ${calc.targetSum}`;
    }

    const gap = calc.currentSum - calc.targetSum;
    return `Waiting... Sum=${calc.currentSum.toFixed(4)} (need -${gap.toFixed(4)})`;
  }

  /**
   * 对冲概率预判
   *
   * 分析历史价格走势，预测在给定 Leg 1 价格下成功对冲的概率
   * 用于决策是否应该进入 Leg 1 持仓
   *
   * @param leg1Side - Leg 1 方向 (UP 或 DOWN)
   * @param leg1Price - Leg 1 入场价格
   * @param priceBuffer - 历史价格缓冲区
   * @param roundSecondsRemaining - 轮次剩余秒数
   */
  predictHedgeProbability(
    leg1Side: Side,
    leg1Price: number,
    priceBuffer: CircularBuffer<PriceSnapshot>,
    roundSecondsRemaining: number
  ): HedgeProbabilityResult {
    const oppositeSide: Side = leg1Side === 'UP' ? 'DOWN' : 'UP';
    const maxLeg2Price = this.getMaxLeg2Price(leg1Price);

    // 获取最近的价格数据用于分析
    const recentPrices = priceBuffer.getRecent(30000); // 最近 30 秒

    // 如果数据不足，返回低置信度结果
    if (recentPrices.length < 5) {
      return {
        probability: 0.5,
        confidence: 0.1,
        expectedTimeToHedge: -1,
        recommendation: 'wait',
        factors: {
          priceVolatility: 0,
          trendDirection: 0,
          spreadHealth: 0,
          timeRemaining: 0,
        },
        reason: '价格数据不足，无法进行可靠预判',
      };
    }

    // 计算各项因子
    const volatility = this.calculateVolatility(recentPrices, oppositeSide);
    const trend = this.calculateTrend(recentPrices, oppositeSide);
    const spreadHealth = this.calculateSpreadHealth(recentPrices);
    const timeImpact = this.calculateTimeImpact(roundSecondsRemaining);

    // 获取当前对方价格
    const latestPrice = recentPrices[recentPrices.length - 1];
    const currentOppositePrice = oppositeSide === 'UP'
      ? latestPrice.upBestAsk
      : latestPrice.downBestAsk;

    // 计算距离对冲目标的差距
    const priceGap = currentOppositePrice - maxLeg2Price;
    const gapPct = currentOppositePrice > 0 ? priceGap / currentOppositePrice : 1;

    // 基于各因子计算概率
    let probability = this.computeProbability(
      gapPct,
      volatility,
      trend,
      spreadHealth,
      timeImpact
    );

    // 计算置信度 (基于数据量和波动稳定性)
    const confidence = Math.min(
      0.9,
      Math.sqrt(recentPrices.length / 100) * (1 - Math.min(volatility * 2, 0.5))
    );

    // 估算预期对冲时间
    const expectedTimeToHedge = this.estimateTimeToHedge(
      priceGap,
      volatility,
      trend,
      roundSecondsRemaining
    );

    // 生成建议
    const { recommendation, reason } = this.generateRecommendation(
      probability,
      confidence,
      gapPct,
      roundSecondsRemaining,
      volatility
    );

    const result: HedgeProbabilityResult = {
      probability,
      confidence,
      expectedTimeToHedge,
      recommendation,
      factors: {
        priceVolatility: volatility,
        trendDirection: trend,
        spreadHealth,
        timeRemaining: timeImpact,
      },
      reason,
    };

    logger.debug('Hedge probability prediction', {
      leg1Side,
      leg1Price,
      maxLeg2Price,
      currentOppositePrice,
      ...result,
    });

    return result;
  }

  /**
   * 计算价格波动率
   */
  private calculateVolatility(prices: PriceSnapshot[], side: Side): number {
    if (prices.length < 2) return 0;

    const priceValues = prices.map(p =>
      side === 'UP' ? p.upBestAsk : p.downBestAsk
    ).filter(p => p > 0);

    if (priceValues.length < 2) return 0;

    // 计算价格变化的标准差
    const changes: number[] = [];
    for (let i = 1; i < priceValues.length; i++) {
      const change = (priceValues[i] - priceValues[i - 1]) / priceValues[i - 1];
      changes.push(change);
    }

    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / changes.length;

    return Math.sqrt(variance);
  }

  /**
   * 计算价格趋势方向
   * 返回 -1 (下跌) 到 1 (上涨) 的值
   */
  private calculateTrend(prices: PriceSnapshot[], side: Side): number {
    if (prices.length < 3) return 0;

    const priceValues = prices.map(p =>
      side === 'UP' ? p.upBestAsk : p.downBestAsk
    ).filter(p => p > 0);

    if (priceValues.length < 3) return 0;

    // 简单线性回归计算趋势
    const n = priceValues.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += priceValues[i];
      sumXY += i * priceValues[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avgPrice = sumY / n;

    // 归一化斜率到 -1 到 1 范围
    const normalizedSlope = slope / avgPrice * 100;
    return Math.max(-1, Math.min(1, normalizedSlope));
  }

  /**
   * 计算价差健康度
   * 基于 bid-ask 价差评估市场流动性
   */
  private calculateSpreadHealth(prices: PriceSnapshot[]): number {
    if (prices.length === 0) return 0;

    const spreads = prices.map(p => {
      const upSpread = p.upBestAsk > 0 && p.upBestBid > 0
        ? (p.upBestAsk - p.upBestBid) / p.upBestAsk
        : 1;
      const downSpread = p.downBestAsk > 0 && p.downBestBid > 0
        ? (p.downBestAsk - p.downBestBid) / p.downBestAsk
        : 1;
      return (upSpread + downSpread) / 2;
    });

    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;

    // 价差越小，健康度越高 (0-1)
    // 价差 <= 2% 视为健康
    return Math.max(0, 1 - avgSpread / 0.02);
  }

  /**
   * 计算时间因素影响
   * 剩余时间越短，对冲机会越少
   */
  private calculateTimeImpact(secondsRemaining: number): number {
    // 轮次总时间假设为 15 分钟 (900 秒)
    const totalSeconds = 900;
    const ratio = secondsRemaining / totalSeconds;

    // 使用平滑曲线
    return Math.pow(ratio, 0.5);
  }

  /**
   * 计算对冲成功概率
   */
  private computeProbability(
    gapPct: number,
    volatility: number,
    trend: number,
    spreadHealth: number,
    timeImpact: number
  ): number {
    // 基础概率：基于价格差距
    // gapPct <= 0 表示已经可以对冲
    let baseProbability: number;
    if (gapPct <= 0) {
      baseProbability = 1.0;
    } else if (gapPct >= 0.15) {
      baseProbability = 0.1;
    } else {
      // 线性插值
      baseProbability = 1.0 - (gapPct / 0.15) * 0.9;
    }

    // 波动率加成：高波动率增加触及机会
    const volatilityBonus = Math.min(volatility * 3, 0.2);

    // 趋势影响：对方价格下跌趋势有利于对冲
    // trend < 0 表示对方价格在下跌 (有利)
    const trendBonus = -trend * 0.15;

    // 价差健康度影响
    const spreadBonus = (spreadHealth - 0.5) * 0.1;

    // 时间因素：剩余时间越少，概率略低
    const timeAdjustment = (timeImpact - 1) * 0.1;

    // 综合计算
    const probability = baseProbability + volatilityBonus + trendBonus + spreadBonus + timeAdjustment;

    return Math.max(0, Math.min(1, probability));
  }

  /**
   * 估算预期对冲时间 (毫秒)
   */
  private estimateTimeToHedge(
    priceGap: number,
    volatility: number,
    trend: number,
    roundSecondsRemaining: number
  ): number {
    if (priceGap <= 0) {
      return 0; // 已经可以对冲
    }

    if (volatility <= 0.001) {
      return -1; // 波动率太低，无法估算
    }

    // 基于波动率和趋势估算到达目标的时间
    // 假设价格变化服从随机游走
    const expectedMovePerSecond = volatility * 0.1; // 粗略估算
    const trendAdjustment = trend < 0 ? 1.2 : 0.8; // 下跌趋势加速估算

    const estimatedSeconds = priceGap / (expectedMovePerSecond * trendAdjustment);
    const estimatedMs = estimatedSeconds * 1000;

    // 限制在轮次剩余时间内
    const maxMs = roundSecondsRemaining * 1000;

    return Math.min(estimatedMs, maxMs);
  }

  /**
   * 生成交易建议
   */
  private generateRecommendation(
    probability: number,
    confidence: number,
    gapPct: number,
    roundSecondsRemaining: number,
    volatility: number
  ): { recommendation: 'enter' | 'wait' | 'skip'; reason: string } {
    // 高概率高置信度：建议进入
    if (probability >= 0.7 && confidence >= 0.5) {
      return {
        recommendation: 'enter',
        reason: `高概率(${(probability * 100).toFixed(0)}%)对冲机会，建议进入`,
      };
    }

    // 已经可以直接对冲
    if (gapPct <= 0) {
      return {
        recommendation: 'enter',
        reason: '当前价格已满足对冲条件，建议立即进入',
      };
    }

    // 时间不足
    if (roundSecondsRemaining < 60) {
      return {
        recommendation: 'skip',
        reason: '轮次剩余时间不足60秒，风险过高',
      };
    }

    // 波动率过低
    if (volatility < 0.005 && gapPct > 0.05) {
      return {
        recommendation: 'skip',
        reason: '市场波动率过低，对冲机会渺茫',
      };
    }

    // 概率中等
    if (probability >= 0.4) {
      return {
        recommendation: 'wait',
        reason: `中等概率(${(probability * 100).toFixed(0)}%)，建议等待更好时机`,
      };
    }

    // 低概率
    return {
      recommendation: 'skip',
      reason: `低概率(${(probability * 100).toFixed(0)}%)，不建议进入`,
    };
  }
}

export default HedgeStrategy;
