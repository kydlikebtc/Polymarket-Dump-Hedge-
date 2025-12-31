/**
 * 终端 Dashboard UI
 *
 * 使用 blessed 库实现交互式终端界面
 * 支持：
 * - 实时价格监控
 * - 手动交易（买入 UP/DOWN）
 * - 运行时参数调整
 * - 交易记录查看
 */

import * as blessed from 'blessed';
import { TradingEngine } from '../core/index.js';
import { eventBus } from '../utils/EventBus.js';
import { logger } from '../utils/logger.js';
import { getAlertManager, type AlertManager, type Alert } from '../utils/AlertManager.js';
import type {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
  CycleStatus,
  Side,
} from '../types/index.js';

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private priceBox: blessed.Widgets.BoxElement;
  private statusBox: blessed.Widgets.BoxElement;
  private alertBox: blessed.Widgets.BoxElement;
  private logBox: blessed.Widgets.Log;
  private tradesBox: blessed.Widgets.ListElement;
  private helpBox: blessed.Widgets.BoxElement;

  private engine: TradingEngine | null = null;
  private alertManager: AlertManager;
  private recentTrades: TradeCycle[] = [];
  private recentAlerts: Alert[] = [];
  private priceHistory: PriceSnapshot[] = [];
  private maxPriceHistory = 60; // 保留60个价格点用于绘图
  private maxRecentAlerts = 10; // 最多显示10条告警

  constructor() {
    // 创建屏幕
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket Dump & Hedge Bot',
      fullUnicode: true,
    });

    // 获取 AlertManager 实例
    this.alertManager = getAlertManager();

    // 创建布局
    this.headerBox = this.createHeaderBox();
    this.priceBox = this.createPriceBox();
    this.statusBox = this.createStatusBox();
    this.alertBox = this.createAlertBox();
    this.logBox = this.createLogBox();
    this.tradesBox = this.createTradesBox();
    this.helpBox = this.createHelpBox();

    // 添加到屏幕
    this.screen.append(this.headerBox);
    this.screen.append(this.priceBox);
    this.screen.append(this.statusBox);
    this.screen.append(this.alertBox);
    this.screen.append(this.logBox);
    this.screen.append(this.tradesBox);
    this.screen.append(this.helpBox);

    // 设置键盘快捷键
    this.setupKeyBindings();

    // 设置事件监听
    this.setupEventListeners();
  }

  /**
   * 创建顶部标题栏
   */
  private createHeaderBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      content: '{center}{bold}Polymarket Dump & Hedge Bot{/bold}{/center}',
      style: {
        fg: 'white',
        bg: 'blue',
        bold: true,
      },
    });
  }

  /**
   * 创建价格显示区域
   */
  private createPriceBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: 0,
      width: '50%',
      height: 10,
      label: ' 📊 实时价格 ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: 'cyan',
        },
      },
    });
  }

  /**
   * 创建状态显示区域
   */
  private createStatusBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: '50%',
      width: '25%',
      height: 10,
      label: ' ⚙️ 系统状态 ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: 'cyan',
        },
      },
    });
  }

  /**
   * 创建告警显示区域
   */
  private createAlertBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: '75%',
      width: '25%',
      height: 10,
      label: ' 🔔 告警 ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: 'magenta',
        },
      },
      scrollable: true,
      mouse: true,
    });
  }

  /**
   * 创建日志显示区域
   */
  private createLogBox(): blessed.Widgets.Log {
    return blessed.log({
      top: 13,
      left: 0,
      width: '60%',
      height: '100%-16',
      label: ' 📝 日志 ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: 'green',
        },
      },
      scrollable: true,
      scrollbar: {
        ch: ' ',
        style: {
          bg: 'yellow',
        },
      },
      mouse: true,
    });
  }

  /**
   * 创建交易记录区域
   */
  private createTradesBox(): blessed.Widgets.ListElement {
    return blessed.list({
      top: 13,
      left: '60%',
      width: '40%',
      height: '100%-16',
      label: ' 💰 最近交易 ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: 'yellow',
        },
        selected: {
          bg: 'blue',
        },
      },
      scrollable: true,
      mouse: true,
      keys: true,
      items: [],
    });
  }

  /**
   * 创建帮助栏
   */
  private createHelpBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      content: ' {cyan-fg}q{/cyan-fg}:退出 | {cyan-fg}s{/cyan-fg}:开始/停止 | {cyan-fg}u{/cyan-fg}:买UP | {cyan-fg}d{/cyan-fg}:买DOWN | {cyan-fg}p{/cyan-fg}:参数 | {cyan-fg}r{/cyan-fg}:刷新 | {cyan-fg}c{/cyan-fg}:清除日志 ',
      style: {
        fg: 'white',
        bg: 'black',
      },
    });
  }

  /**
   * 设置键盘快捷键
   */
  private setupKeyBindings(): void {
    // 退出
    this.screen.key(['q', 'C-c'], () => {
      this.log('{yellow-fg}正在退出...{/yellow-fg}');
      this.screen.destroy();
      process.emit('SIGINT', 'SIGINT');
    });

    // 开始/停止
    this.screen.key(['s'], async () => {
      if (!this.engine) return;

      if (this.engine.isEngineRunning()) {
        this.log('{yellow-fg}停止交易引擎...{/yellow-fg}');
        await this.engine.stop();
      } else {
        this.log('{green-fg}启动交易引擎...{/green-fg}');
        await this.engine.start();
      }
      this.updateStatus();
    });

    // 手动买入 UP
    this.screen.key(['u'], async () => {
      if (!this.engine) return;
      await this.showManualBuyDialog('UP');
    });

    // 手动买入 DOWN
    this.screen.key(['d'], async () => {
      if (!this.engine) return;
      await this.showManualBuyDialog('DOWN');
    });

    // 调整参数
    this.screen.key(['p'], () => {
      if (!this.engine) return;
      this.showParamsDialog();
    });

    // 刷新
    this.screen.key(['r'], () => {
      this.updateAll();
      this.log('{cyan-fg}界面已刷新{/cyan-fg}');
    });

    // 清除日志
    this.screen.key(['c'], () => {
      this.logBox.setContent('');
      this.screen.render();
    });

    // 聚焦日志区域滚动
    this.screen.key(['l'], () => {
      this.logBox.focus();
    });

    // 聚焦交易区域
    this.screen.key(['t'], () => {
      this.tradesBox.focus();
    });
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    // 价格更新
    eventBus.onEvent('price:update', (snapshot: PriceSnapshot) => {
      this.priceHistory.push(snapshot);
      if (this.priceHistory.length > this.maxPriceHistory) {
        this.priceHistory.shift();
      }
      this.updatePrice(snapshot);
    });

    // 暴跌信号
    eventBus.onEvent('price:dump_detected', (signal: DumpSignal) => {
      this.log(
        `{red-fg}🚨 暴跌! ${signal.side} ${signal.previousPrice.toFixed(4)} → ${signal.price.toFixed(4)} ` +
        `(${(signal.dropPct * 100).toFixed(2)}%){/red-fg}`
      );
    });

    // 订单事件
    eventBus.onEvent('order:submitted', (order: Order) => {
      this.log(`{blue-fg}📤 订单提交: ${order.side} ${order.shares} @ ${order.price?.toFixed(4) || 'MKT'}{/blue-fg}`);
    });

    eventBus.onEvent('order:filled', (order: Order) => {
      this.log(`{green-fg}✅ 订单成交: ${order.side} @ ${order.avgFillPrice?.toFixed(4)}{/green-fg}`);
    });

    eventBus.onEvent('order:error', (data: { order: Order; error: Error }) => {
      this.log(`{red-fg}❌ 订单失败: ${data.error.message}{/red-fg}`);
    });

    // 交易周期完成
    eventBus.onEvent('cycle:completed', ({ cycle, profit }: { cycle: TradeCycle; profit: number }) => {
      this.recentTrades.unshift(cycle);
      if (this.recentTrades.length > 20) {
        this.recentTrades.pop();
      }
      this.updateTrades();
      this.log(
        `{green-fg}🎉 交易完成! 净利润: $${profit.toFixed(2)}{/green-fg}`
      );
    });

    // WebSocket 事件
    eventBus.onEvent('ws:connected', () => {
      this.log('{green-fg}📡 WebSocket 已连接{/green-fg}');
      this.updateStatus();
    });

    eventBus.onEvent('ws:disconnected', () => {
      this.log('{yellow-fg}📡 WebSocket 断开{/yellow-fg}');
      this.updateStatus();
    });

    eventBus.onEvent('ws:reconnecting', ({ attempt }) => {
      this.log(`{yellow-fg}📡 重连中... #${attempt}{/yellow-fg}`);
    });

    // 回合事件
    eventBus.onEvent('round:new', (data: { roundSlug: string; startTime: number }) => {
      this.log(`{cyan-fg}📅 新回合: ${data.roundSlug}{/cyan-fg}`);
      this.updateStatus();
    });

    // 错误
    eventBus.onEvent('system:error', (error: Error) => {
      this.log(`{red-fg}❌ 错误: ${error.message}{/red-fg}`);
    });

    // 告警事件
    eventBus.onEvent('alert:sent', (alert: Alert) => {
      this.recentAlerts.unshift(alert);
      if (this.recentAlerts.length > this.maxRecentAlerts) {
        this.recentAlerts.pop();
      }
      this.updateAlerts();
    });
  }

  /**
   * 绑定交易引擎
   */
  public setEngine(engine: TradingEngine): void {
    this.engine = engine;
    this.updateStatus();
  }

  /**
   * 更新价格显示
   */
  private updatePrice(snapshot: PriceSnapshot): void {
    const sum = snapshot.upBestAsk + snapshot.downBestAsk;
    const sumColor = sum <= 0.95 ? 'green' : sum <= 0.98 ? 'yellow' : 'red';

    // 简单的 ASCII 价格柱状图
    const upBar = '█'.repeat(Math.floor(snapshot.upBestAsk * 20));
    const downBar = '█'.repeat(Math.floor(snapshot.downBestAsk * 20));

    const content = [
      '',
      `  UP   Price: {bold}${snapshot.upBestAsk.toFixed(4)}{/bold}`,
      `  {green-fg}${upBar}{/green-fg}`,
      '',
      `  DOWN Price: {bold}${snapshot.downBestAsk.toFixed(4)}{/bold}`,
      `  {red-fg}${downBar}{/red-fg}`,
      '',
      `  SUM: {${sumColor}-fg}{bold}${sum.toFixed(4)}{/bold}{/${sumColor}-fg}`,
    ].join('\n');

    this.priceBox.setContent(content);
    this.screen.render();
  }

  /**
   * 更新状态显示
   */
  private updateStatus(): void {
    if (!this.engine) {
      this.statusBox.setContent('\n  引擎未初始化');
      this.screen.render();
      return;
    }

    const isRunning = this.engine.isEngineRunning();
    const currentState = this.engine.getStateMachine().getCurrentStatus();
    const currentCycle = this.engine.getStateMachine().getCurrentCycle();
    const currentRound = this.engine.getRoundManager().getCurrentRoundSlug();

    const stateColor: Record<CycleStatus, string> = {
      'IDLE': 'white',
      'WATCHING': 'cyan',
      'LEG1_PENDING': 'yellow',
      'LEG1_FILLED': 'green',
      'LEG2_PENDING': 'yellow',
      'COMPLETED': 'green',
      'ROUND_EXPIRED': 'red',
      'ERROR': 'red',
    };

    const content = [
      '',
      `  运行状态: ${isRunning ? '{green-fg}运行中 ✅{/green-fg}' : '{red-fg}已停止 ❌{/red-fg}'}`,
      `  当前状态: {${stateColor[currentState]}-fg}{bold}${currentState}{/bold}{/${stateColor[currentState]}-fg}`,
      `  当前回合: ${currentRound || 'N/A'}`,
      currentCycle ? `  活跃周期: ${currentCycle.id.slice(0, 8)}...` : '',
      '',
      `  {gray-fg}更新时间: ${new Date().toLocaleTimeString()}{/gray-fg}`,
    ].filter(Boolean).join('\n');

    this.statusBox.setContent(content);
    this.screen.render();
  }

  /**
   * 更新交易记录
   */
  private updateTrades(): void {
    const items = this.recentTrades.map(trade => {
      const profit = trade.profit || 0;
      const profitStr = profit >= 0
        ? `+$${profit.toFixed(2)}`
        : `-$${Math.abs(profit).toFixed(2)}`;
      const color = profit >= 0 ? 'green' : 'red';

      return `{${color}-fg}${trade.leg1?.side || 'N/A'} ${profitStr}{/${color}-fg}`;
    });

    this.tradesBox.setItems(items);
    this.screen.render();
  }

  /**
   * 更新告警显示
   */
  private updateAlerts(): void {
    const severityColors: Record<string, string> = {
      'critical': 'red',
      'warning': 'yellow',
      'info': 'cyan',
    };

    const severityIcons: Record<string, string> = {
      'critical': '🚨',
      'warning': '⚠️',
      'info': 'ℹ️',
    };

    const stats = this.alertManager.getStats();
    const lines: string[] = [];

    // 显示统计
    lines.push(`  今日: {bold}${stats.todayCount}{/bold}`);
    lines.push(`  总计: {gray-fg}${stats.totalCount}{/gray-fg}`);
    lines.push('');

    // 显示最近告警
    if (this.recentAlerts.length === 0) {
      lines.push('  {gray-fg}暂无告警{/gray-fg}');
    } else {
      for (const alert of this.recentAlerts.slice(0, 5)) {
        const color = severityColors[alert.severity] || 'white';
        const icon = severityIcons[alert.severity] || '•';
        const time = new Date(alert.timestamp).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        });
        lines.push(`  {${color}-fg}${icon} ${time}{/${color}-fg}`);
      }
    }

    this.alertBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  /**
   * 添加日志
   */
  public log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logBox.log(`{gray-fg}[${timestamp}]{/gray-fg} ${message}`);
  }

  /**
   * 更新所有显示
   */
  private updateAll(): void {
    this.updateStatus();
    this.updateTrades();
    this.updateAlerts();
    if (this.priceHistory.length > 0) {
      this.updatePrice(this.priceHistory[this.priceHistory.length - 1]);
    }
  }

  /**
   * 启动 Dashboard
   */
  public start(): void {
    this.log('{green-fg}Dashboard 启动{/green-fg}');
    this.updateStatus();
    this.updateAlerts();
    this.screen.render();

    // 定期刷新状态和告警
    setInterval(() => {
      this.updateStatus();
      this.updateAlerts();
    }, 1000);
  }

  /**
   * 销毁 Dashboard
   */
  public destroy(): void {
    this.screen.destroy();
  }

  // ===== 交互式对话框 =====

  /**
   * 显示手动买入对话框
   */
  private async showManualBuyDialog(side: Side): Promise<void> {
    const currentPrice = this.priceHistory.length > 0
      ? this.priceHistory[this.priceHistory.length - 1]
      : null;

    const priceStr = currentPrice
      ? (side === 'UP' ? currentPrice.upBestAsk : currentPrice.downBestAsk).toFixed(4)
      : 'N/A';

    const prompt = blessed.prompt({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      label: ` 手动买入 ${side} @ ${priceStr} `,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: side === 'UP' ? 'green' : 'red',
        },
      },
    });

    prompt.input('输入份数 (shares):', '', async (err, value) => {
      prompt.destroy();
      this.screen.render();

      if (err || !value) {
        this.log('{yellow-fg}买入取消{/yellow-fg}');
        return;
      }

      const shares = parseFloat(value);
      if (isNaN(shares) || shares <= 0) {
        this.log('{red-fg}无效的份数{/red-fg}');
        return;
      }

      this.log(`{cyan-fg}正在买入 ${side} ${shares} 份...{/cyan-fg}`);

      try {
        await this.engine!.manualBuy(side, shares, true);
        this.log(`{green-fg}买入成功: ${side} ${shares} 份{/green-fg}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`{red-fg}买入失败: ${errorMsg}{/red-fg}`);
        logger.error('Manual buy failed', { side, shares, error: errorMsg });
      }
    });

    this.screen.render();
  }

  /**
   * 显示参数调整对话框
   */
  private showParamsDialog(): void {
    const config = this.engine!.getConfig();

    const form = blessed.form({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 18,
      label: ' 调整交易参数 ',
      tags: true,
      keys: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan',
        },
      },
    });

    // 份数
    blessed.text({
      parent: form,
      top: 1,
      left: 2,
      content: `份数 (shares): ${config.shares}`,
      tags: true,
    });

    const sharesInput = blessed.textbox({
      parent: form,
      name: 'shares',
      top: 1,
      left: 25,
      width: 15,
      height: 1,
      inputOnFocus: true,
      value: String(config.shares),
      style: {
        fg: 'white',
        bg: 'blue',
        focus: {
          bg: 'green',
        },
      },
    });

    // sumTarget
    blessed.text({
      parent: form,
      top: 3,
      left: 2,
      content: `对冲阈值 (sumTarget): ${config.sumTarget}`,
      tags: true,
    });

    const sumTargetInput = blessed.textbox({
      parent: form,
      name: 'sumTarget',
      top: 3,
      left: 25,
      width: 15,
      height: 1,
      inputOnFocus: true,
      value: String(config.sumTarget),
      style: {
        fg: 'white',
        bg: 'blue',
        focus: {
          bg: 'green',
        },
      },
    });

    // movePct
    blessed.text({
      parent: form,
      top: 5,
      left: 2,
      content: `暴跌阈值 (movePct): ${(config.movePct * 100).toFixed(1)}%`,
      tags: true,
    });

    const movePctInput = blessed.textbox({
      parent: form,
      name: 'movePct',
      top: 5,
      left: 25,
      width: 15,
      height: 1,
      inputOnFocus: true,
      value: String((config.movePct * 100).toFixed(1)),
      style: {
        fg: 'white',
        bg: 'blue',
        focus: {
          bg: 'green',
        },
      },
    });

    // windowMin
    blessed.text({
      parent: form,
      top: 7,
      left: 2,
      content: `监控窗口 (windowMin): ${config.windowMin} 分钟`,
      tags: true,
    });

    const windowMinInput = blessed.textbox({
      parent: form,
      name: 'windowMin',
      top: 7,
      left: 25,
      width: 15,
      height: 1,
      inputOnFocus: true,
      value: String(config.windowMin),
      style: {
        fg: 'white',
        bg: 'blue',
        focus: {
          bg: 'green',
        },
      },
    });

    // 按钮
    const saveBtn = blessed.button({
      parent: form,
      top: 10,
      left: 2,
      width: 12,
      height: 3,
      content: '保存',
      align: 'center',
      style: {
        fg: 'white',
        bg: 'green',
        focus: {
          bg: 'cyan',
        },
      },
    });

    const cancelBtn = blessed.button({
      parent: form,
      top: 10,
      left: 16,
      width: 12,
      height: 3,
      content: '取消',
      align: 'center',
      style: {
        fg: 'white',
        bg: 'red',
        focus: {
          bg: 'magenta',
        },
      },
    });

    // 事件处理
    saveBtn.on('press', () => {
      const newShares = parseFloat(sharesInput.getValue() || String(config.shares));
      const newSumTarget = parseFloat(sumTargetInput.getValue() || String(config.sumTarget));
      const newMovePct = parseFloat(movePctInput.getValue() || String(config.movePct * 100)) / 100;
      const newWindowMin = parseFloat(windowMinInput.getValue() || String(config.windowMin));

      // 验证
      if (isNaN(newShares) || newShares <= 0) {
        this.log('{red-fg}无效的份数{/red-fg}');
        return;
      }
      if (isNaN(newSumTarget) || newSumTarget < 0.5 || newSumTarget > 1.0) {
        this.log('{red-fg}sumTarget 必须在 0.5-1.0 之间{/red-fg}');
        return;
      }
      if (isNaN(newMovePct) || newMovePct < 0.01 || newMovePct > 0.30) {
        this.log('{red-fg}movePct 必须在 1%-30% 之间{/red-fg}');
        return;
      }
      if (isNaN(newWindowMin) || newWindowMin < 1 || newWindowMin > 15) {
        this.log('{red-fg}windowMin 必须在 1-15 之间{/red-fg}');
        return;
      }

      // 更新配置
      this.engine!.updateConfig({
        shares: newShares,
        sumTarget: newSumTarget,
        movePct: newMovePct,
        windowMin: newWindowMin,
      });

      this.log(`{green-fg}参数已更新: shares=${newShares}, sumTarget=${newSumTarget}, movePct=${(newMovePct * 100).toFixed(1)}%, windowMin=${newWindowMin}{/green-fg}`);

      form.destroy();
      this.screen.render();
    });

    cancelBtn.on('press', () => {
      this.log('{yellow-fg}参数调整取消{/yellow-fg}');
      form.destroy();
      this.screen.render();
    });

    // ESC 关闭
    form.key(['escape'], () => {
      form.destroy();
      this.screen.render();
    });

    // Tab 切换焦点
    sharesInput.focus();

    this.screen.render();
  }
}
