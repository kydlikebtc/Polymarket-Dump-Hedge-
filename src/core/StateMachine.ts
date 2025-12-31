/**
 * 交易周期状态机
 * 管理从暴跌检测到对冲完成的完整交易流程
 */

import { v4 as uuidv4 } from 'uuid';
import { logger, logTrade } from '../utils/logger.js';
import { eventBus } from '../utils/EventBus.js';
import type {
  CycleStatus,
  TradeCycle,
  LegInfo,
  StateTransition,
  DumpSignal,
  OrderResult,
} from '../types/index.js';

// 有效的状态转换映射
const VALID_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  'IDLE': ['WATCHING'],
  'WATCHING': ['LEG1_PENDING', 'ROUND_EXPIRED', 'ERROR'],
  'LEG1_PENDING': ['LEG1_FILLED', 'ROUND_EXPIRED', 'ERROR'],
  'LEG1_FILLED': ['LEG2_PENDING', 'ROUND_EXPIRED', 'ERROR'],
  'LEG2_PENDING': ['COMPLETED', 'ROUND_EXPIRED', 'ERROR'],
  'COMPLETED': ['IDLE'],
  'ROUND_EXPIRED': ['IDLE'],
  'ERROR': ['IDLE'],
};

// 默认超时配置 (毫秒)
const DEFAULT_TIMEOUTS = {
  LEG1_PENDING: 30 * 1000,   // Leg1 下单后 30 秒未成交
  LEG1_FILLED: 120 * 1000,   // Leg1 成交后 120 秒未能对冲 (警告)
  LEG2_PENDING: 30 * 1000,   // Leg2 下单后 30 秒未成交
};

export interface TimeoutConfig {
  leg1PendingTimeout: number;
  leg1FilledTimeout: number;
  leg2PendingTimeout: number;
}

export class StateMachine {
  private currentCycle: TradeCycle | null = null;
  private transitionHistory: StateTransition[] = [];
  private onCycleComplete?: (cycle: TradeCycle) => void;
  private timeoutConfig: TimeoutConfig;

  constructor(timeoutConfig?: Partial<TimeoutConfig>) {
    this.timeoutConfig = {
      leg1PendingTimeout: timeoutConfig?.leg1PendingTimeout ?? DEFAULT_TIMEOUTS.LEG1_PENDING,
      leg1FilledTimeout: timeoutConfig?.leg1FilledTimeout ?? DEFAULT_TIMEOUTS.LEG1_FILLED,
      leg2PendingTimeout: timeoutConfig?.leg2PendingTimeout ?? DEFAULT_TIMEOUTS.LEG2_PENDING,
    };
    logger.info('StateMachine initialized', { timeoutConfig: this.timeoutConfig });
  }

  /**
   * 获取当前周期
   */
  getCurrentCycle(): TradeCycle | null {
    return this.currentCycle;
  }

  /**
   * 获取当前状态
   */
  getCurrentStatus(): CycleStatus {
    return this.currentCycle?.status || 'IDLE';
  }

  /**
   * 开始新的交易周期
   */
  startNewCycle(roundSlug: string): TradeCycle {
    if (this.currentCycle && !this.isTerminalState(this.currentCycle.status)) {
      logger.warn('Starting new cycle while previous cycle is active', {
        previousCycleId: this.currentCycle.id,
        previousStatus: this.currentCycle.status,
      });
    }

    const cycle: TradeCycle = {
      id: uuidv4(),
      roundSlug,
      status: 'IDLE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.currentCycle = cycle;
    this.transitionHistory = [];

    logger.info('New trade cycle started', { cycleId: cycle.id, roundSlug });
    eventBus.emitEvent('cycle:started', cycle);

    // 立即转换到 WATCHING 状态
    this.transition('WATCHING', 'start_watching');

    return cycle;
  }

  /**
   * 执行状态转换
   */
  transition(
    newStatus: CycleStatus,
    event: string,
    data?: Record<string, unknown>
  ): boolean {
    if (!this.currentCycle) {
      logger.error('No active cycle for transition', { newStatus, event });
      return false;
    }

    const currentStatus = this.currentCycle.status;

    // 验证转换是否有效
    if (!this.isValidTransition(currentStatus, newStatus)) {
      logger.error('Invalid state transition', {
        from: currentStatus,
        to: newStatus,
        event,
      });
      return false;
    }

    // 记录转换历史
    const transition: StateTransition = {
      from: currentStatus,
      to: newStatus,
      event,
      timestamp: Date.now(),
      data,
    };
    this.transitionHistory.push(transition);

    // 更新状态
    this.currentCycle.status = newStatus;
    this.currentCycle.updatedAt = Date.now();

    logger.info(`State transition: ${currentStatus} -> ${newStatus}`, {
      cycleId: this.currentCycle.id,
      event,
      data,
    });

    // 记录交易日志
    logTrade('state_transition', {
      cycleId: this.currentCycle.id,
      from: currentStatus,
      to: newStatus,
      event,
      data,
    });

    return true;
  }

  /**
   * 检查转换是否有效
   */
  private isValidTransition(from: CycleStatus, to: CycleStatus): boolean {
    const validTargets = VALID_TRANSITIONS[from];
    return validTargets?.includes(to) || false;
  }

  /**
   * 检查是否为终止状态
   */
  private isTerminalState(status: CycleStatus): boolean {
    return ['COMPLETED', 'ROUND_EXPIRED', 'ERROR'].includes(status);
  }

  /**
   * 处理暴跌信号 - 触发 Leg 1
   */
  onDumpDetected(signal: DumpSignal): boolean {
    if (!this.currentCycle || this.currentCycle.status !== 'WATCHING') {
      logger.debug('Ignoring dump signal - not in WATCHING state', {
        currentStatus: this.currentCycle?.status,
      });
      return false;
    }

    logger.info('Dump signal received', {
      cycleId: this.currentCycle.id,
      side: signal.side,
      dropPct: signal.dropPct,
      price: signal.price,
    });

    return this.transition('LEG1_PENDING', 'dump_detected', {
      side: signal.side,
      dropPct: signal.dropPct,
      price: signal.price,
    });
  }

  /**
   * 处理 Leg 1 成交
   */
  onLeg1Filled(orderResult: OrderResult): boolean {
    if (!this.currentCycle || this.currentCycle.status !== 'LEG1_PENDING') {
      logger.error('Unexpected Leg 1 fill - not in LEG1_PENDING state', {
        currentStatus: this.currentCycle?.status,
      });
      return false;
    }

    const leg1: LegInfo = {
      orderId: orderResult.orderId,
      side: orderResult.side,
      shares: orderResult.shares,
      entryPrice: orderResult.avgPrice,
      totalCost: orderResult.totalCost,
      filledAt: orderResult.timestamp,
    };

    this.currentCycle.leg1 = leg1;

    logger.info('Leg 1 filled', {
      cycleId: this.currentCycle.id,
      leg1,
    });

    logTrade('leg1_filled', {
      cycleId: this.currentCycle.id,
      ...leg1,
    });

    const success = this.transition('LEG1_FILLED', 'leg1_filled', leg1 as unknown as Record<string, unknown>);

    if (success) {
      eventBus.emitEvent('cycle:leg1_filled', {
        cycle: this.currentCycle,
        leg: leg1,
      });
    }

    return success;
  }

  /**
   * 开始执行 Leg 2
   */
  onLeg2Started(): boolean {
    if (!this.currentCycle || this.currentCycle.status !== 'LEG1_FILLED') {
      logger.error('Cannot start Leg 2 - not in LEG1_FILLED state', {
        currentStatus: this.currentCycle?.status,
      });
      return false;
    }

    return this.transition('LEG2_PENDING', 'leg2_started');
  }

  /**
   * 处理 Leg 2 成交
   */
  onLeg2Filled(orderResult: OrderResult): boolean {
    if (!this.currentCycle || this.currentCycle.status !== 'LEG2_PENDING') {
      logger.error('Unexpected Leg 2 fill - not in LEG2_PENDING state', {
        currentStatus: this.currentCycle?.status,
      });
      return false;
    }

    const leg2: LegInfo = {
      orderId: orderResult.orderId,
      side: orderResult.side,
      shares: orderResult.shares,
      entryPrice: orderResult.avgPrice,
      totalCost: orderResult.totalCost,
      filledAt: orderResult.timestamp,
    };

    this.currentCycle.leg2 = leg2;

    // 计算保证收益
    if (this.currentCycle.leg1) {
      const totalCost = this.currentCycle.leg1.totalCost + leg2.totalCost;
      const guaranteedReturn = 1.0 * this.currentCycle.leg1.shares;
      this.currentCycle.guaranteedProfit = guaranteedReturn - totalCost;
      this.currentCycle.profit = this.currentCycle.guaranteedProfit;
    }

    logger.info('Leg 2 filled - cycle complete', {
      cycleId: this.currentCycle.id,
      leg2,
      profit: this.currentCycle.profit,
    });

    logTrade('leg2_filled', {
      cycleId: this.currentCycle.id,
      ...leg2,
      totalProfit: this.currentCycle.profit,
    });

    const success = this.transition('COMPLETED', 'leg2_filled', {
      ...leg2,
      profit: this.currentCycle.profit,
    });

    if (success) {
      eventBus.emitEvent('cycle:leg2_filled', {
        cycle: this.currentCycle,
        leg: leg2,
      });

      eventBus.emitEvent('cycle:completed', {
        cycle: this.currentCycle,
        profit: this.currentCycle.profit || 0,
      });

      if (this.onCycleComplete) {
        this.onCycleComplete(this.currentCycle);
      }
    }

    return success;
  }

  /**
   * 处理轮次过期
   */
  onRoundExpired(): boolean {
    if (!this.currentCycle) {
      return false;
    }

    // 如果有未对冲的 Leg 1，记录为损失
    if (
      this.currentCycle.status === 'LEG1_FILLED' &&
      this.currentCycle.leg1
    ) {
      this.currentCycle.profit = -this.currentCycle.leg1.totalCost;

      logger.warn('Round expired with unhedged Leg 1 - recording loss', {
        cycleId: this.currentCycle.id,
        loss: this.currentCycle.profit,
      });

      logTrade('round_expired_loss', {
        cycleId: this.currentCycle.id,
        leg1: this.currentCycle.leg1,
        loss: this.currentCycle.profit,
      });
    }

    const success = this.transition('ROUND_EXPIRED', 'round_expired');

    if (success) {
      eventBus.emitEvent('cycle:expired', this.currentCycle);
    }

    return success;
  }

  /**
   * 处理错误
   */
  onError(error: Error): boolean {
    if (!this.currentCycle) {
      return false;
    }

    this.currentCycle.error = error.message;

    logger.error('Trade cycle error', {
      cycleId: this.currentCycle.id,
      error: error.message,
      status: this.currentCycle.status,
    });

    const success = this.transition('ERROR', 'error', { error: error.message });

    if (success) {
      eventBus.emitEvent('cycle:error', {
        cycle: this.currentCycle,
        error,
      });
    }

    return success;
  }

  /**
   * 重置到 IDLE 状态
   */
  reset(): void {
    if (this.currentCycle && this.isTerminalState(this.currentCycle.status)) {
      this.currentCycle = null;
      this.transitionHistory = [];
      logger.info('State machine reset to IDLE');
    }
  }

  /**
   * 设置周期完成回调
   */
  setOnCycleComplete(callback: (cycle: TradeCycle) => void): void {
    this.onCycleComplete = callback;
  }

  /**
   * 获取转换历史
   */
  getTransitionHistory(): StateTransition[] {
    return [...this.transitionHistory];
  }

  /**
   * 检查是否在活跃状态 (可以处理信号)
   */
  isActive(): boolean {
    return this.currentCycle?.status === 'WATCHING';
  }

  /**
   * 检查是否正在等待对冲
   */
  isWaitingForHedge(): boolean {
    return this.currentCycle?.status === 'LEG1_FILLED';
  }

  /**
   * 获取 Leg 1 信息 (如果存在)
   */
  getLeg1(): LegInfo | undefined {
    return this.currentCycle?.leg1;
  }

  /**
   * 检查当前状态是否超时
   * 返回超时信息，供 TradingEngine 处理
   */
  checkTimeout(): {
    isTimeout: boolean;
    status: CycleStatus | null;
    elapsedMs: number;
    timeoutMs: number;
    action: 'none' | 'warn' | 'cancel' | 'expire';
  } {
    if (!this.currentCycle) {
      return { isTimeout: false, status: null, elapsedMs: 0, timeoutMs: 0, action: 'none' };
    }

    const status = this.currentCycle.status;
    const now = Date.now();

    // 获取进入当前状态的时间
    const lastTransition = this.transitionHistory[this.transitionHistory.length - 1];
    const stateEntryTime = lastTransition?.timestamp ?? this.currentCycle.createdAt;
    const elapsedMs = now - stateEntryTime;

    let timeoutMs = 0;
    let action: 'none' | 'warn' | 'cancel' | 'expire' = 'none';

    switch (status) {
      case 'LEG1_PENDING':
        timeoutMs = this.timeoutConfig.leg1PendingTimeout;
        if (elapsedMs > timeoutMs) {
          action = 'cancel'; // 取消 Leg1 订单
        }
        break;

      case 'LEG1_FILLED':
        timeoutMs = this.timeoutConfig.leg1FilledTimeout;
        if (elapsedMs > timeoutMs) {
          action = 'warn'; // 警告：长时间未对冲
        }
        break;

      case 'LEG2_PENDING':
        timeoutMs = this.timeoutConfig.leg2PendingTimeout;
        if (elapsedMs > timeoutMs) {
          action = 'cancel'; // 取消 Leg2 订单
        }
        break;

      default:
        // 其他状态不检查超时
        break;
    }

    const isTimeout = action !== 'none';

    if (isTimeout) {
      logger.warn('State timeout detected', {
        cycleId: this.currentCycle.id,
        status,
        elapsedMs,
        timeoutMs,
        action,
      });
    }

    return { isTimeout, status, elapsedMs, timeoutMs, action };
  }

  /**
   * 获取 Leg1 未对冲的持续时间 (毫秒)
   * 用于 UI 显示和决策
   */
  getLeg1UnhedgedDuration(): number {
    if (!this.currentCycle || this.currentCycle.status !== 'LEG1_FILLED') {
      return 0;
    }

    const leg1 = this.currentCycle.leg1;
    if (!leg1) {
      return 0;
    }

    return Date.now() - leg1.filledAt;
  }

  /**
   * 检查是否应该强制过期 (轮次即将结束但仍有未对冲的 Leg1)
   */
  shouldForceExpire(roundRemainingSeconds: number): boolean {
    if (!this.currentCycle) {
      return false;
    }

    const status = this.currentCycle.status;

    // 如果在 LEG1_FILLED 状态且轮次剩余时间不足，应该强制过期
    if (status === 'LEG1_FILLED' && roundRemainingSeconds < 10) {
      logger.warn('Force expire: round ending with unhedged Leg1', {
        cycleId: this.currentCycle.id,
        roundRemainingSeconds,
      });
      return true;
    }

    // 如果在等待状态且轮次剩余时间不足
    if ((status === 'LEG1_PENDING' || status === 'LEG2_PENDING') && roundRemainingSeconds < 5) {
      logger.warn('Force expire: round ending with pending order', {
        cycleId: this.currentCycle.id,
        status,
        roundRemainingSeconds,
      });
      return true;
    }

    return false;
  }

  /**
   * 获取超时配置
   */
  getTimeoutConfig(): TimeoutConfig {
    return { ...this.timeoutConfig };
  }

  /**
   * 更新超时配置
   */
  updateTimeoutConfig(config: Partial<TimeoutConfig>): void {
    if (config.leg1PendingTimeout !== undefined) {
      this.timeoutConfig.leg1PendingTimeout = config.leg1PendingTimeout;
    }
    if (config.leg1FilledTimeout !== undefined) {
      this.timeoutConfig.leg1FilledTimeout = config.leg1FilledTimeout;
    }
    if (config.leg2PendingTimeout !== undefined) {
      this.timeoutConfig.leg2PendingTimeout = config.leg2PendingTimeout;
    }
    logger.info('Timeout config updated', { timeoutConfig: this.timeoutConfig });
  }
}

export default StateMachine;
