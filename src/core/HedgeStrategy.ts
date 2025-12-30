/**
 * 对冲策略模块
 * 计算对冲条件和收益
 */

import { logger, logTrade } from '../utils/logger.js';
import type {
  BotConfig,
  PriceSnapshot,
  Side,
  LegInfo,
} from '../types/index.js';

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

    const fees = totalCost * this.config.feeRate;
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
}

export default HedgeStrategy;
