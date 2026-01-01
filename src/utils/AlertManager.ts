/**
 * 风控告警管理器
 *
 * 支持多渠道告警：
 * - Console: 本地控制台输出
 * - Telegram: Telegram Bot API
 * - Discord: Discord Webhook
 *
 * 告警级别：
 * - info: 信息通知（交易完成、状态变更等）
 * - warning: 警告（连接中断、订单部分成交等）
 * - critical: 严重（订单失败、资金不足、系统错误等）
 */

import { logger } from './logger.js';
import { eventBus } from './EventBus.js';
import type { Alert, AlertSeverity, TradeCycle, DumpSignal } from '../types/index.js';

// 重新导出 Alert 类型供外部使用
export type { Alert } from '../types/index.js';

export interface AlertConfig {
  // 启用的告警渠道
  channels: {
    console: boolean;
    telegram?: {
      botToken: string;
      chatId: string;
      enabled: boolean;
    };
    discord?: {
      webhookUrl: string;
      enabled: boolean;
    };
  };

  // 告警级别过滤
  minSeverity: AlertSeverity;

  // 告警节流配置 (防止告警风暴)
  throttle: {
    enabled: boolean;
    windowMs: number;         // 时间窗口
    maxPerWindow: number;     // 窗口内最大告警数
  };

  // 静默时段
  quietHours?: {
    enabled: boolean;
    startHour: number;        // 0-23
    endHour: number;          // 0-23
    timezone: string;         // 如 'Asia/Shanghai'
  };
}

const DEFAULT_CONFIG: AlertConfig = {
  channels: {
    console: true,
  },
  minSeverity: 'info',
  throttle: {
    enabled: true,
    windowMs: 60000,          // 1分钟
    maxPerWindow: 10,
  },
};

const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export class AlertManager {
  private config: AlertConfig;
  private alertHistory: Alert[] = [];
  private throttleCounter: number = 0;
  private throttleWindowStart: number = 0;

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('AlertManager initialized', {
      channels: Object.keys(this.config.channels).filter(
        (k) => (this.config.channels as Record<string, unknown>)[k]
      ),
      minSeverity: this.config.minSeverity,
    });
  }

  /**
   * 发送告警
   */
  async send(alert: Alert): Promise<void> {
    // 检查告警级别
    if (SEVERITY_PRIORITY[alert.severity] < SEVERITY_PRIORITY[this.config.minSeverity]) {
      return;
    }

    // 检查节流
    if (this.isThrottled()) {
      logger.debug('Alert throttled', { title: alert.title });
      return;
    }

    // 检查静默时段
    if (this.isQuietHours()) {
      logger.debug('Alert suppressed during quiet hours', { title: alert.title });
      return;
    }

    // 记录历史
    this.alertHistory.push(alert);
    if (this.alertHistory.length > 100) {
      this.alertHistory.shift();
    }

    // 更新节流计数
    this.updateThrottleCounter();

    // 发射告警事件供 Dashboard 等组件监听
    eventBus.emit('alert:sent', alert);

    // 发送到各渠道
    const promises: Promise<void>[] = [];

    if (this.config.channels.console) {
      promises.push(this.sendToConsole(alert));
    }

    if (this.config.channels.telegram?.enabled) {
      promises.push(this.sendToTelegram(alert));
    }

    if (this.config.channels.discord?.enabled) {
      promises.push(this.sendToDiscord(alert));
    }

    await Promise.allSettled(promises);
  }

  /**
   * 发送到控制台
   */
  private async sendToConsole(alert: Alert): Promise<void> {
    const emoji = this.getSeverityEmoji(alert.severity);
    const timestamp = new Date(alert.timestamp).toLocaleString();

    const message = `
${emoji} [${alert.severity.toUpperCase()}] ${alert.title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${alert.message}
${alert.data ? `\n数据: ${JSON.stringify(alert.data, null, 2)}` : ''}
时间: ${timestamp}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

    console.log(message);
  }

  /**
   * 发送到 Telegram
   */
  private async sendToTelegram(alert: Alert): Promise<void> {
    const { botToken, chatId } = this.config.channels.telegram!;

    try {
      const emoji = this.getSeverityEmoji(alert.severity);
      const text = this.formatTelegramMessage(alert, emoji);

      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Telegram API error: ${response.status} ${errorData}`);
      }

      logger.debug('Telegram alert sent', { title: alert.title });
    } catch (error) {
      logger.error('Failed to send Telegram alert', {
        error,
        title: alert.title,
      });
    }
  }

  /**
   * 发送到 Discord
   */
  private async sendToDiscord(alert: Alert): Promise<void> {
    const { webhookUrl } = this.config.channels.discord!;

    try {
      const color = this.getDiscordColor(alert.severity);
      const embed = this.formatDiscordEmbed(alert, color);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'PM Dump & Hedge Bot',
          embeds: [embed],
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Discord Webhook error: ${response.status} ${errorData}`);
      }

      logger.debug('Discord alert sent', { title: alert.title });
    } catch (error) {
      logger.error('Failed to send Discord alert', {
        error,
        title: alert.title,
      });
    }
  }

  // ===== 预定义告警 =====

  /**
   * 交易完成告警
   */
  async alertTradeCompleted(cycle: TradeCycle, profit: number): Promise<void> {
    const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;

    await this.send({
      severity: profit >= 0 ? 'info' : 'warning',
      title: '交易完成',
      message: `${cycle.leg1?.side} -> ${cycle.leg2?.side} 对冲完成\n净利润: ${profitStr}`,
      timestamp: Date.now(),
      data: {
        cycleId: cycle.id,
        leg1Price: cycle.leg1?.entryPrice,
        leg2Price: cycle.leg2?.entryPrice,
        profit,
      },
    });
  }

  /**
   * 暴跌检测告警
   */
  async alertDumpDetected(signal: DumpSignal): Promise<void> {
    await this.send({
      severity: 'info',
      title: '暴跌信号检测',
      message: `${signal.side} 价格暴跌 ${(signal.dropPct * 100).toFixed(2)}%\n${signal.previousPrice.toFixed(4)} → ${signal.price.toFixed(4)}`,
      timestamp: Date.now(),
      data: {
        side: signal.side,
        dropPct: signal.dropPct,
        price: signal.price,
        previousPrice: signal.previousPrice,
        roundSlug: signal.roundSlug,
      },
    });
  }

  /**
   * 订单失败告警
   */
  async alertOrderFailed(side: string, error: string): Promise<void> {
    await this.send({
      severity: 'critical',
      title: '订单执行失败',
      message: `${side} 订单失败: ${error}`,
      timestamp: Date.now(),
      data: { side, error },
    });
  }

  /**
   * WebSocket 断开告警
   */
  async alertWebSocketDisconnected(code: number, reason: string): Promise<void> {
    await this.send({
      severity: 'warning',
      title: 'WebSocket 断开',
      message: `连接已断开\n代码: ${code}\n原因: ${reason}`,
      timestamp: Date.now(),
      data: { code, reason },
    });
  }

  /**
   * 资金不足告警
   */
  async alertInsufficientFunds(required: number, available: number): Promise<void> {
    await this.send({
      severity: 'critical',
      title: '资金不足',
      message: `需要: $${required.toFixed(2)}\n可用: $${available.toFixed(2)}`,
      timestamp: Date.now(),
      data: { required, available },
    });
  }

  /**
   * 轮次过期告警 (未对冲)
   */
  async alertRoundExpiredWithLoss(cycle: TradeCycle, loss: number): Promise<void> {
    await this.send({
      severity: 'critical',
      title: '轮次过期 - 未对冲损失',
      message: `Leg1 未能对冲\n损失: $${Math.abs(loss).toFixed(2)}`,
      timestamp: Date.now(),
      data: {
        cycleId: cycle.id,
        leg1Side: cycle.leg1?.side,
        leg1Price: cycle.leg1?.entryPrice,
        loss,
      },
    });
  }

  /**
   * 系统错误告警
   */
  async alertSystemError(error: Error): Promise<void> {
    await this.send({
      severity: 'critical',
      title: '系统错误',
      message: error.message,
      timestamp: Date.now(),
      data: {
        name: error.name,
        stack: error.stack?.slice(0, 500),
      },
    });
  }

  // ===== 辅助方法 =====

  private isThrottled(): boolean {
    if (!this.config.throttle.enabled) {
      return false;
    }

    const now = Date.now();
    if (now - this.throttleWindowStart > this.config.throttle.windowMs) {
      // 新窗口
      this.throttleWindowStart = now;
      this.throttleCounter = 0;
      return false;
    }

    return this.throttleCounter >= this.config.throttle.maxPerWindow;
  }

  private updateThrottleCounter(): void {
    if (!this.config.throttle.enabled) {
      return;
    }

    const now = Date.now();
    if (now - this.throttleWindowStart > this.config.throttle.windowMs) {
      this.throttleWindowStart = now;
      this.throttleCounter = 1;
    } else {
      this.throttleCounter++;
    }
  }

  private isQuietHours(): boolean {
    const config = this.config.quietHours;
    if (!config?.enabled) {
      return false;
    }

    const now = new Date();
    // 简化：使用本地时间
    const currentHour = now.getHours();

    if (config.startHour <= config.endHour) {
      // 同一天内的静默时段，如 22:00 - 06:00
      return currentHour >= config.startHour && currentHour < config.endHour;
    } else {
      // 跨午夜的静默时段，如 22:00 - 06:00
      return currentHour >= config.startHour || currentHour < config.endHour;
    }
  }

  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case 'info':
        return 'ℹ️';
      case 'warning':
        return '⚠️';
      case 'critical':
        return '🚨';
      default:
        return '📢';
    }
  }

  private getDiscordColor(severity: AlertSeverity): number {
    switch (severity) {
      case 'info':
        return 0x3498db; // Blue
      case 'warning':
        return 0xf39c12; // Orange
      case 'critical':
        return 0xe74c3c; // Red
      default:
        return 0x95a5a6; // Gray
    }
  }

  private formatTelegramMessage(alert: Alert, emoji: string): string {
    const timestamp = new Date(alert.timestamp).toLocaleString();
    let message = `${emoji} <b>${alert.title}</b>\n\n${alert.message}\n\n<i>时间: ${timestamp}</i>`;

    if (alert.data) {
      const dataStr = Object.entries(alert.data)
        .map(([k, v]) => `• ${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
        .join('\n');
      message += `\n\n<code>${dataStr}</code>`;
    }

    return message;
  }

  private formatDiscordEmbed(alert: Alert, color: number): Record<string, unknown> {
    const embed: Record<string, unknown> = {
      title: alert.title,
      description: alert.message,
      color,
      timestamp: new Date(alert.timestamp).toISOString(),
      footer: {
        text: 'PM Dump & Hedge Bot',
      },
    };

    if (alert.data) {
      embed.fields = Object.entries(alert.data).map(([name, value]) => ({
        name,
        value: String(typeof value === 'number' ? value.toFixed(4) : value),
        inline: true,
      }));
    }

    return embed;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('AlertManager config updated');
  }

  /**
   * 获取告警历史
   */
  getHistory(): Alert[] {
    return [...this.alertHistory];
  }

  /**
   * 清除历史
   */
  clearHistory(): void {
    this.alertHistory = [];
  }

  /**
   * 获取告警统计信息
   */
  getStats(): { todayCount: number; totalCount: number } {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    const todayCount = this.alertHistory.filter(
      (alert) => alert.timestamp >= todayStart
    ).length;

    return {
      todayCount,
      totalCount: this.alertHistory.length,
    };
  }
}

// 全局单例
let alertManager: AlertManager | null = null;

export function getAlertManager(): AlertManager {
  if (!alertManager) {
    alertManager = new AlertManager();
  }
  return alertManager;
}

export function initAlertManager(config: Partial<AlertConfig>): AlertManager {
  alertManager = new AlertManager(config);
  return alertManager;
}
