/**
 * 终端 Dashboard UI
 *
 * 使用 blessed 库实现交互式终端界面
 */

import * as blessed from 'blessed';
import { TradingEngine } from '../core/index.js';
import { eventBus } from '../utils/EventBus.js';
import { logger } from '../utils/logger.js';
import {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
  CycleStatus,
} from '../types/index.js';

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private priceBox: blessed.Widgets.BoxElement;
  private statusBox: blessed.Widgets.BoxElement;
  private logBox: blessed.Widgets.Log;
  private tradesBox: blessed.Widgets.ListElement;
  private helpBox: blessed.Widgets.BoxElement;

  private engine: TradingEngine | null = null;
  private recentTrades: TradeCycle[] = [];
  private priceHistory: PriceSnapshot[] = [];
  private maxPriceHistory = 60; // 保留60个价格点用于绘图

  constructor() {
    // 创建屏幕
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket Dump & Hedge Bot',
      fullUnicode: true,
    });

    // 创建布局
    this.headerBox = this.createHeaderBox();
    this.priceBox = this.createPriceBox();
    this.statusBox = this.createStatusBox();
    this.logBox = this.createLogBox();
    this.tradesBox = this.createTradesBox();
    this.helpBox = this.createHelpBox();

    // 添加到屏幕
    this.screen.append(this.headerBox);
    this.screen.append(this.priceBox);
    this.screen.append(this.statusBox);
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
      width: '50%',
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
      content: ' {cyan-fg}q{/cyan-fg}:退出 | {cyan-fg}s{/cyan-fg}:开始/停止 | {cyan-fg}m{/cyan-fg}:手动买入 | {cyan-fg}r{/cyan-fg}:刷新 | {cyan-fg}c{/cyan-fg}:清除日志 ',
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

      const status = this.engine.getStatus();
      if (status.isRunning) {
        this.log('{yellow-fg}停止交易引擎...{/yellow-fg}');
        await this.engine.stop();
      } else {
        this.log('{green-fg}启动交易引擎...{/green-fg}');
        await this.engine.start();
      }
      this.updateStatus();
    });

    // 手动买入
    this.screen.key(['m'], async () => {
      if (!this.engine) return;

      // 简单实现 - 实际应该弹出输入框
      this.log('{cyan-fg}手动买入功能 - 请在代码中配置{/cyan-fg}');
      // await this.engine.manualBuy('UP', 0.5, 100);
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
    eventBus.on('price:update', (snapshot: PriceSnapshot) => {
      this.priceHistory.push(snapshot);
      if (this.priceHistory.length > this.maxPriceHistory) {
        this.priceHistory.shift();
      }
      this.updatePrice(snapshot);
    });

    // 暴跌信号
    eventBus.on('dump:detected', (signal: DumpSignal) => {
      this.log(
        `{red-fg}🚨 暴跌! ${signal.side} ${signal.startPrice.toFixed(4)} → ${signal.endPrice.toFixed(4)} ` +
        `(${(signal.pctChange * 100).toFixed(2)}%){/red-fg}`
      );
    });

    // 状态变化
    eventBus.on('state:change', (data: { from: CycleStatus; to: CycleStatus; cycleId: string }) => {
      this.log(`{cyan-fg}状态: ${data.from} → ${data.to}{/cyan-fg}`);
      this.updateStatus();
    });

    // 订单事件
    eventBus.on('order:submitted', (order: Order) => {
      this.log(`{blue-fg}📤 订单提交: ${order.side} ${order.shares} @ ${order.price.toFixed(4)}{/blue-fg}`);
    });

    eventBus.on('order:filled', (order: Order) => {
      this.log(`{green-fg}✅ 订单成交: ${order.side} @ ${order.fillPrice?.toFixed(4)}{/green-fg}`);
    });

    eventBus.on('order:failed', (data: { order: Order; error: string }) => {
      this.log(`{red-fg}❌ 订单失败: ${data.error}{/red-fg}`);
    });

    // 交易周期完成
    eventBus.on('cycle:completed', (cycle: TradeCycle) => {
      this.recentTrades.unshift(cycle);
      if (this.recentTrades.length > 20) {
        this.recentTrades.pop();
      }
      this.updateTrades();
      this.log(
        `{green-fg}🎉 交易完成! 净利润: $${cycle.netProfit?.toFixed(2)}{/green-fg}`
      );
    });

    // WebSocket 事件
    eventBus.on('ws:connected', () => {
      this.log('{green-fg}📡 WebSocket 已连接{/green-fg}');
      this.updateStatus();
    });

    eventBus.on('ws:disconnected', () => {
      this.log('{yellow-fg}📡 WebSocket 断开{/yellow-fg}');
      this.updateStatus();
    });

    eventBus.on('ws:reconnecting', (attempt: number) => {
      this.log(`{yellow-fg}📡 重连中... #${attempt}{/yellow-fg}`);
    });

    // 回合事件
    eventBus.on('round:new', (data: { roundId: string; endTime: number }) => {
      this.log(`{cyan-fg}📅 新回合: ${data.roundId}{/cyan-fg}`);
      this.updateStatus();
    });

    // 错误
    eventBus.on('error', (error: Error) => {
      this.log(`{red-fg}❌ 错误: ${error.message}{/red-fg}`);
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
    const sum = snapshot.upPrice + snapshot.downPrice;
    const sumColor = sum <= 0.95 ? 'green' : sum <= 0.98 ? 'yellow' : 'red';

    // 简单的 ASCII 价格柱状图
    const upBar = '█'.repeat(Math.floor(snapshot.upPrice * 20));
    const downBar = '█'.repeat(Math.floor(snapshot.downPrice * 20));

    const content = [
      '',
      `  UP   Price: {bold}${snapshot.upPrice.toFixed(4)}{/bold}`,
      `  {green-fg}${upBar}{/green-fg}`,
      '',
      `  DOWN Price: {bold}${snapshot.downPrice.toFixed(4)}{/bold}`,
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

    const status = this.engine.getStatus();
    const stateColor = {
      'IDLE': 'white',
      'WATCHING': 'cyan',
      'LEG1_PENDING': 'yellow',
      'LEG1_FILLED': 'green',
      'LEG2_PENDING': 'yellow',
      'COMPLETED': 'green',
      'ROUND_EXPIRED': 'red',
      'ERROR': 'red',
    }[status.currentState] || 'white';

    const content = [
      '',
      `  运行状态: ${status.isRunning ? '{green-fg}运行中 ✅{/green-fg}' : '{red-fg}已停止 ❌{/red-fg}'}`,
      `  当前状态: {${stateColor}-fg}{bold}${status.currentState}{/bold}{/${stateColor}-fg}`,
      `  当前回合: ${status.currentRound || 'N/A'}`,
      status.activeCycle ? `  活跃周期: ${status.activeCycle.slice(0, 8)}...` : '',
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
      const profit = trade.netProfit || 0;
      const profitStr = profit >= 0
        ? `+$${profit.toFixed(2)}`
        : `-$${Math.abs(profit).toFixed(2)}`;
      const color = profit >= 0 ? 'green' : 'red';

      return `{${color}-fg}${trade.leg1Side} ${profitStr}{/${color}-fg}`;
    });

    this.tradesBox.setItems(items);
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
    this.screen.render();

    // 定期刷新状态
    setInterval(() => {
      this.updateStatus();
    }, 1000);
  }

  /**
   * 销毁 Dashboard
   */
  public destroy(): void {
    this.screen.destroy();
  }
}
