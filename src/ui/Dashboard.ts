/**
 * 终端 Dashboard UI
 *
 * 使用 blessed 库实现交互式终端界面
 * v0.3.0: 重新设计 UI，突出套利机会
 *
 * 支持：
 * - 实时价格监控与套利分析
 * - 持仓显示与盈亏计算
 * - 手动交易（买入 UP/DOWN）
 * - 运行时参数调整
 * - 最近交易记录
 */

import type * as BlessedTypes from 'blessed';
import * as blessedModule from 'blessed';
import { TradingEngine } from '../core/index.js';

// ESM/CommonJS 兼容性处理：blessed 使用 CommonJS 导出，需要通过 default 访问
const blessed: typeof BlessedTypes = (blessedModule as any).default || blessedModule;
import { eventBus } from '../utils/EventBus.js';
import { logger } from '../utils/logger.js';
import { getAlertManager, type Alert } from '../utils/AlertManager.js';
import type {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
  CycleStatus,
  Side,
  MarketTrade,
} from '../types/index.js';
import type { OrderBookSnapshot } from '../api/MarketWatcher.js';

// 主题颜色配置
const THEME = {
  primary: 'cyan',
  success: 'green',
  danger: 'red',
  warning: 'yellow',
  muted: 'gray',
  bg: 'black',
  border: 'cyan',
};

export class Dashboard {
  private screen: BlessedTypes.Widgets.Screen;
  private headerBox: BlessedTypes.Widgets.BoxElement;
  private marketInfoBox: BlessedTypes.Widgets.BoxElement;
  private orderBookBox: BlessedTypes.Widgets.BoxElement;
  private positionsBox: BlessedTypes.Widgets.BoxElement;
  private marketAnalysisBox: BlessedTypes.Widgets.BoxElement;
  private transactionsBox: BlessedTypes.Widgets.BoxElement;
  private statusBox: BlessedTypes.Widgets.BoxElement;
  private helpBox: BlessedTypes.Widgets.BoxElement;

  private engine: TradingEngine | null = null;
  private recentTrades: TradeCycle[] = [];
  private recentAlerts: Alert[] = [];
  private priceHistory: PriceSnapshot[] = [];
  private maxPriceHistory = 60;
  private maxRecentAlerts = 10;

  // 模拟持仓数据 (实际应从数据库/状态获取)
  private positions = {
    up: { shares: 0, avgCost: 0, totalCost: 0 },
    down: { shares: 0, avgCost: 0, totalCost: 0 },
  };

  constructor() {
    // 创建屏幕
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket Dump & Hedge Bot',
      fullUnicode: true,
    });

    // AlertManager 实例可通过 getAlertManager() 获取
    void getAlertManager;

    // 创建新布局
    this.headerBox = this.createHeaderBox();
    this.marketInfoBox = this.createMarketInfoBox();
    this.orderBookBox = this.createOrderBookBox();
    this.positionsBox = this.createPositionsBox();
    this.marketAnalysisBox = this.createMarketAnalysisBox();
    this.transactionsBox = this.createTransactionsBox();
    this.statusBox = this.createStatusBox();
    this.helpBox = this.createHelpBox();

    // 添加到屏幕
    this.screen.append(this.headerBox);
    this.screen.append(this.marketInfoBox);
    this.screen.append(this.orderBookBox);
    this.screen.append(this.positionsBox);
    this.screen.append(this.marketAnalysisBox);
    this.screen.append(this.transactionsBox);
    this.screen.append(this.statusBox);
    this.screen.append(this.helpBox);

    // 设置键盘快捷键
    this.setupKeyBindings();

    // 设置事件监听
    this.setupEventListeners();
  }

  /**
   * 创建顶部标题栏 - 参考图2风格
   */
  private createHeaderBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      content: '{bold} ⓑ POLYMARKET DUMP & HEDGE BOT v0.3{/bold}                                                    {green-fg}● MONITORING{/green-fg}',
      style: {
        fg: THEME.primary,
        bg: 'black',
        bold: true,
      },
      border: {
        type: 'line',
      },
    });
  }

  /**
   * 创建持仓显示区域 - 参考图2的 POSITIONS 区块
   */
  private createPositionsBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 26,
      left: 0,
      width: '50%',
      height: 12,
      label: ' ═ POSITIONS ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.border,
        },
        label: {
          fg: THEME.primary,
        },
      },
    });
  }

  /**
   * 创建市场分析区域 - 核心套利信息展示（增大高度以显示完整信息）
   */
  private createMarketAnalysisBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 26,
      left: '50%',
      width: '50%',
      height: 12,
      label: ' ═ MARKET ANALYSIS ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.border,
        },
        label: {
          fg: THEME.primary,
        },
      },
    });
  }

  /**
   * 创建最近交易区域
   */
  private createTransactionsBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 38,
      left: 0,
      width: '70%',
      height: '100%-41',
      label: ' ═ 📊 RECENT TRANSACTIONS ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.border,
        },
        label: {
          fg: THEME.primary,
        },
      },
      scrollable: true,
      mouse: true,
    });
  }

  /**
   * 创建状态区域
   */
  private createStatusBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 38,
      left: '70%',
      width: '30%',
      height: '100%-41',
      label: ' ═ STATUS ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.border,
        },
        label: {
          fg: THEME.primary,
        },
      },
    });
  }

  /**
   * 创建帮助栏
   */
  private createHelpBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      content: ' {cyan-fg}[Q]{/cyan-fg} Quit  {cyan-fg}[S]{/cyan-fg} Start/Stop  {cyan-fg}[U]{/cyan-fg} Buy UP  {cyan-fg}[D]{/cyan-fg} Buy DOWN  {cyan-fg}[P]{/cyan-fg} Params  {cyan-fg}[R]{/cyan-fg} Refresh ',
      style: {
        fg: 'white',
        bg: 'black',
      },
      border: {
        type: 'line',
      },
    });
  }

  /**
   * 创建市场信息区域 - 显示 Polymarket Market ID 和 Token IDs
   */
  private createMarketInfoBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: 0,
      width: '100%',
      height: 7,
      label: ' ═ MARKET INFO ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.border,
        },
        label: {
          fg: THEME.primary,
        },
      },
    });
  }

  /**
   * 创建订单簿显示区域 - 参考图的 Order Book 风格
   */
  private createOrderBookBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 10,
      left: 0,
      width: '100%',
      height: 16,
      label: ' ═ ORDER BOOK ═ ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        fg: 'white',
        border: {
          fg: THEME.warning,
        },
        label: {
          fg: THEME.warning,
        },
      },
    });
  }

  /**
   * 设置键盘快捷键
   */
  private setupKeyBindings(): void {
    // 退出
    this.screen.key(['q', 'C-c'], () => {
      this.screen.destroy();
      process.emit('SIGINT', 'SIGINT');
    });

    // 开始/停止
    this.screen.key(['s'], async () => {
      if (!this.engine) return;

      if (this.engine.isEngineRunning()) {
        await this.engine.stop();
      } else {
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
      this.updateMarketInfo();
      this.updateOrderBook();
      this.updateMarketAnalysis(snapshot);
      this.updatePositions(snapshot);
    });

    // 暴跌信号
    eventBus.onEvent('price:dump_detected', (signal: DumpSignal) => {
      this.addTransaction('DUMP', signal.side, signal.price, 0, `${(signal.dropPct * 100).toFixed(2)}% drop`);
    });

    // 订单成交
    eventBus.onEvent('order:filled', (order: Order) => {
      this.addTransaction('FILL', order.side, order.avgFillPrice || 0, order.shares, order.id);
    });

    // 交易周期完成
    eventBus.onEvent('cycle:completed', ({ cycle }: { cycle: TradeCycle; profit: number }) => {
      this.recentTrades.unshift(cycle);
      if (this.recentTrades.length > 20) {
        this.recentTrades.pop();
      }
    });

    // WebSocket 事件
    eventBus.onEvent('ws:connected', () => {
      this.updateStatus();
    });

    eventBus.onEvent('ws:disconnected', () => {
      this.updateStatus();
    });

    // 回合事件
    eventBus.onEvent('round:new', () => {
      this.updateStatus();
      this.updateMarketInfo();
    });

    // 市场切换事件 - 更新市场信息显示
    eventBus.onEvent('market:switched', () => {
      this.updateMarketInfo();
      this.log('市场信息已更新');
    });

    // 告警事件
    eventBus.onEvent('alert:sent', (alert: Alert) => {
      this.recentAlerts.unshift(alert);
      if (this.recentAlerts.length > this.maxRecentAlerts) {
        this.recentAlerts.pop();
      }
    });

    // v0.3.0: 市场交易事件 - 显示市场所有成交
    eventBus.onEvent('market:trade', (trade: MarketTrade) => {
      this.addMarketTrade(trade);
    });
  }

  /**
   * 绑定交易引擎
   */
  public setEngine(engine: TradingEngine): void {
    this.engine = engine;
    this.updateStatus();
    this.updateMarketInfo();
  }

  /**
   * 更新持仓显示 - 紧凑版
   */
  private updatePositions(snapshot: PriceSnapshot): void {
    const upPrice = snapshot.upBestAsk || snapshot.upBestBid || 0;
    const downPrice = snapshot.downBestAsk || snapshot.downBestBid || 0;

    // 计算当前价值和盈亏
    const upPnL = this.positions.up.shares * upPrice - this.positions.up.totalCost;
    const downPnL = this.positions.down.shares * downPrice - this.positions.down.totalCost;
    const totalPnL = upPnL + downPnL;

    const formatPnL = (pnl: number) => {
      if (pnl >= 0) return `{green-fg}+$${pnl.toFixed(2)}{/green-fg}`;
      return `{red-fg}-$${Math.abs(pnl).toFixed(2)}{/red-fg}`;
    };

    const content = [
      '',
      `  {green-fg}▲ UP{/green-fg}   ${this.positions.up.shares} @ ${upPrice.toFixed(3)}`,
      `  {red-fg}▼ DOWN{/red-fg} ${this.positions.down.shares} @ ${downPrice.toFixed(3)}`,
      '',
      `  {bold}Total PnL:{/bold} ${formatPnL(totalPnL)}`,
      `  {gray-fg}Vol: $${(this.positions.up.totalCost + this.positions.down.totalCost).toFixed(0)}{/gray-fg}`,
    ].join('\n');

    this.positionsBox.setContent(content);
    this.screen.render();
  }

  /**
   * 更新市场分析 - 核心套利信息展示（完整版，含可视化进度条）
   */
  private updateMarketAnalysis(snapshot: PriceSnapshot): void {
    const upAsk = snapshot.upBestAsk || 0;
    const downAsk = snapshot.downBestAsk || 0;
    const upBid = snapshot.upBestBid || 0;
    const downBid = snapshot.downBestBid || 0;

    // 计算关键指标
    const combined = upAsk + downAsk;
    const sumTarget = this.engine?.getConfig().sumTarget || 0.95;
    const arbOpportunity = combined <= sumTarget;
    const config = this.engine?.getConfig();
    const shares = config?.shares || 0;
    const potentialProfit = arbOpportunity ? (1 - combined) * shares : 0;

    // 计算价差
    const spread = 1 - combined;
    const spreadPct = (spread * 100).toFixed(2);

    // 计算 Delta (UP - DOWN 价格差异)
    const delta = upAsk - downAsk;
    const deltaPct = (delta * 100).toFixed(1);

    // 获取交易周期数
    const cycles = this.recentTrades.length;
    const totalPnL = this.recentTrades.reduce((sum, c) => sum + (c.profit || 0), 0);

    // 套利状态颜色
    const combinedColor = arbOpportunity ? 'green' : combined <= 1.0 ? 'yellow' : 'red';

    // 创建可视化进度条 (40 字符宽)
    const barWidth = 40;
    const fillRatio = Math.min(Math.max((1 - combined) / (1 - sumTarget), 0), 1);
    const filledWidth = Math.round(fillRatio * barWidth);
    const emptyWidth = barWidth - filledWidth;
    const progressBar = arbOpportunity
      ? `{green-fg}${'█'.repeat(filledWidth)}${'░'.repeat(emptyWidth)}{/green-fg}`
      : `{yellow-fg}${'░'.repeat(barWidth)}{/yellow-fg}`;

    const content = [
      '',
      `  {green-fg}▲ UP:{/green-fg}  ${(upAsk * 100).toFixed(2)}%    {bold}Combined:{/bold} {${combinedColor}-fg}${combined.toFixed(4)}{/${combinedColor}-fg}    {bold}Spread:{/bold} ${spreadPct}%`,
      `  {red-fg}▼ DOWN:{/red-fg} ${(downAsk * 100).toFixed(2)}%    {bold}Target:{/bold}   ${sumTarget}              `,
      '',
      `  ${progressBar}`,
      '',
      `  {gray-fg}Bid:{/gray-fg} UP ${(upBid * 100).toFixed(2)}% | DOWN ${(downBid * 100).toFixed(2)}%    {gray-fg}Delta:{/gray-fg} ${deltaPct}%`,
      `  {gray-fg}Pairs:{/gray-fg} ${cycles}    {gray-fg}PnL:{/gray-fg} ${totalPnL >= 0 ? '{green-fg}' : '{red-fg}'}$${totalPnL.toFixed(2)}${totalPnL >= 0 ? '{/green-fg}' : '{/red-fg}'}`,
      '',
      arbOpportunity
        ? `  {green-fg}{bold}🎯 ARBITRAGE OPPORTUNITY! +$${potentialProfit.toFixed(2)}{/bold}{/green-fg}`
        : `  {gray-fg}Monitoring for arbitrage...{/gray-fg}`,
    ].join('\n');

    this.marketAnalysisBox.setContent(content);
    this.screen.render();
  }

  /**
   * 更新市场信息显示 - 显示 Polymarket Market ID 和 Token IDs
   * 参考图风格：显示市场名称、剩余时间、UP/DOWN 价格
   */
  private updateMarketInfo(): void {
    if (!this.engine) {
      this.marketInfoBox.setContent('\n  {gray-fg}等待引擎初始化...{/gray-fg}');
      this.screen.render();
      return;
    }

    const roundManager = this.engine.getRoundManager();
    const marketName = roundManager.getMarketName();
    const endTime = roundManager.getRoundEndTime();
    const upToken = roundManager.getUpTokenId();
    const downToken = roundManager.getDownTokenId();
    const latestPrice = this.priceHistory.length > 0 ? this.priceHistory[this.priceHistory.length - 1] : null;

    // 截断 Token ID 显示
    const formatToken = (token: string | null): string => {
      if (!token) return '{gray-fg}N/A{/gray-fg}';
      return `{yellow-fg}${token.substring(0, 12)}...${token.slice(-8)}{/yellow-fg}`;
    };

    // 计算剩余时间 (秒)
    const remainingSecs = roundManager.getSecondsRemaining();
    const hours = Math.floor(remainingSecs / 3600);
    const minutes = Math.floor((remainingSecs % 3600) / 60);
    const seconds = remainingSecs % 60;

    // 根据剩余时间显示不同格式
    let timeStr: string;
    if (hours > 0) {
      timeStr = `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    } else {
      timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    const timeColor = remainingSecs < 60 ? 'red' : remainingSecs < 180 ? 'yellow' : 'green';

    // 结束时间格式化 (UTC)
    const endTimeStr = endTime > 0 ? new Date(endTime).toISOString().replace('T', ' ').substring(0, 19) + ' UTC' : 'N/A';

    // UP/DOWN 价格百分比
    const upPrice = latestPrice?.upBestAsk || 0;
    const downPrice = latestPrice?.downBestAsk || 0;
    const upPct = (upPrice * 100).toFixed(1);
    const downPct = (downPrice * 100).toFixed(1);

    const content = [
      '',
      `  {bold}Market:{/bold} {cyan-fg}${marketName}{/cyan-fg}`,
      `  {bold}Ends:{/bold} {white-fg}${endTimeStr}{/white-fg}    {bold}Remaining:{/bold} {${timeColor}-fg}${timeStr}{/${timeColor}-fg}`,
      `  {green-fg}▲ UP: ${upPct}%{/green-fg}    {red-fg}▼ DOWN: ${downPct}%{/red-fg}`,
      `  {gray-fg}UP:{/gray-fg} ${formatToken(upToken)}  {gray-fg}DOWN:{/gray-fg} ${formatToken(downToken)}`,
    ].join('\n');

    this.marketInfoBox.setContent(content);
    this.screen.render();
  }

  /**
   * 更新订单簿显示 - 参考图的 Order Book 风格
   * 左侧显示 UP 的 BIDS/ASKS，右侧显示 DOWN 的 BIDS/ASKS
   */
  private updateOrderBook(): void {
    if (!this.engine) {
      this.orderBookBox.setContent('\n  {gray-fg}Waiting for data...{/gray-fg}');
      this.screen.render();
      return;
    }

    const marketWatcher = this.engine.getMarketWatcher();
    const snapshot: OrderBookSnapshot | null = marketWatcher.getOrderBookSnapshot();

    if (!snapshot) {
      this.orderBookBox.setContent('\n  {gray-fg}Waiting for order book data...{/gray-fg}');
      this.screen.render();
      return;
    }

    const upBook = snapshot.up;
    const downBook = snapshot.down;

    // 格式化订单簿行
    const formatLevel = (price: number, size: number, color: string): string => {
      const pricePct = `${(price * 100).toFixed(1)}%`;
      const sizeStr = size.toFixed(0);
      return `{${color}-fg}${pricePct.padStart(6)}{/${color}-fg} @ ${sizeStr.padStart(5)}`;
    };

    // 计算 UP/DOWN 的 Best Bid/Ask
    const upBestBid = upBook.bids[0]?.price || 0;
    const upBestAsk = upBook.asks[0]?.price || 0;
    const downBestBid = downBook.bids[0]?.price || 0;
    const downBestAsk = downBook.asks[0]?.price || 0;

    // 计算总量
    const upBidTotal = upBook.bids.reduce((sum, l) => sum + l.size, 0);
    const upAskTotal = upBook.asks.reduce((sum, l) => sum + l.size, 0);
    const downBidTotal = downBook.bids.reduce((sum, l) => sum + l.size, 0);
    const downAskTotal = downBook.asks.reduce((sum, l) => sum + l.size, 0);

    const lines: string[] = [''];

    // 标题行
    lines.push(`  {bold}{green-fg}UP Order Book{/green-fg}{/bold}                          {bold}{red-fg}DOWN Order Book{/red-fg}{/bold}`);
    lines.push(`  Bid: ${(upBestBid * 100).toFixed(1)}% | Ask: ${(upBestAsk * 100).toFixed(1)}%              Bid: ${(downBestBid * 100).toFixed(1)}% | Ask: ${(downBestAsk * 100).toFixed(1)}%`);
    lines.push('');

    // 表头
    lines.push(`  {cyan-fg}BIDS (${upBidTotal.toFixed(0).padStart(4)}){/cyan-fg}    {cyan-fg}ASKS (${upAskTotal.toFixed(0).padStart(4)}){/cyan-fg}       {cyan-fg}BIDS (${downBidTotal.toFixed(0).padStart(4)}){/cyan-fg}    {cyan-fg}ASKS (${downAskTotal.toFixed(0).padStart(4)}){/cyan-fg}`);

    // 显示最多 10 档
    const maxLevels = 10;
    for (let i = 0; i < maxLevels; i++) {
      const upBid = upBook.bids[i];
      const upAsk = upBook.asks[i];
      const downBid = downBook.bids[i];
      const downAsk = downBook.asks[i];

      const upBidStr = upBid ? formatLevel(upBid.price, upBid.size, 'green') : '        -     ';
      const upAskStr = upAsk ? formatLevel(upAsk.price, upAsk.size, 'red') : '        -     ';
      const downBidStr = downBid ? formatLevel(downBid.price, downBid.size, 'green') : '        -     ';
      const downAskStr = downAsk ? formatLevel(downAsk.price, downAsk.size, 'red') : '        -     ';

      lines.push(`  ${upBidStr}   ${upAskStr}      ${downBidStr}   ${downAskStr}`);
    }

    this.orderBookBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  /**
   * 添加交易记录
   */
  private addTransaction(_type: string, side: Side, price: number, size: number, info: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const sideColor = side === 'UP' ? 'green' : 'red';
    const sideSymbol = side === 'UP' ? '▲' : '▼';

    // 获取当前内容并添加新行
    const currentContent = this.transactionsBox.getContent();
    const newLine = `  {gray-fg}${time}{/gray-fg}  {${sideColor}-fg}${sideSymbol} ${side}{/${sideColor}-fg}  $${price.toFixed(4)}  ${size}$  {gray-fg}${info.substring(0, 20)}...{/gray-fg}`;

    // 保持最近 20 条
    const lines = currentContent.split('\n').filter(l => l.trim());
    lines.push(newLine);
    if (lines.length > 20) {
      lines.shift();
    }

    // 添加表头
    const header = '\n  {cyan-fg}TIME         SIDE     PRICE       SIZE      TX HASH{/cyan-fg}\n';
    this.transactionsBox.setContent(header + lines.join('\n'));
    this.screen.render();
  }

  /**
   * v0.3.0: 添加市场交易记录
   * 显示市场上所有成交（不仅仅是用户自己的订单）
   */
  private addMarketTrade(trade: MarketTrade): void {
    // 判断是 UP 还是 DOWN token
    const roundManager = this.engine?.getRoundManager();
    if (!roundManager) {
      return;
    }

    const upTokenId = roundManager.getUpTokenId() || '';
    const downTokenId = roundManager.getDownTokenId() || '';

    // 过滤掉不属于当前市场的交易
    if (trade.assetId !== upTokenId && trade.assetId !== downTokenId) {
      return;
    }

    let tokenLabel: string;
    let tokenColor: string;
    let tokenSymbol: string;

    if (trade.assetId === upTokenId) {
      tokenLabel = 'YES';
      tokenColor = 'green';
      tokenSymbol = '▲';
    } else {
      tokenLabel = 'NO';
      tokenColor = 'red';
      tokenSymbol = '▼';
    }

    // 验证并格式化时间
    const timestamp = Number.isFinite(trade.timestamp) && trade.timestamp > 0
      ? trade.timestamp
      : Date.now();
    const time = new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    // 交易方向颜色
    const directionColor = trade.side === 'BUY' ? 'green' : 'red';
    const directionLabel = trade.side === 'BUY' ? 'BUY ' : 'SELL';

    // 格式化价格和数量（带数值验证）
    const priceStr = Number.isFinite(trade.price)
      ? (trade.price * 100).toFixed(1) + '%'
      : 'N/A';
    const sizeStr = Number.isFinite(trade.size) && trade.size > 0
      ? trade.size.toFixed(0)
      : '-';

    // 获取当前内容并添加新行
    const currentContent = this.transactionsBox.getContent();
    const newLine = `  {gray-fg}${time}{/gray-fg}  {${tokenColor}-fg}${tokenSymbol}${tokenLabel.padEnd(3)}{/${tokenColor}-fg}  {${directionColor}-fg}${directionLabel}{/${directionColor}-fg}  ${priceStr.padStart(6)}  ${sizeStr.padStart(5)}`;

    // 分离表头和数据行
    const allLines = currentContent.split('\n');
    const headerLines = allLines.slice(0, 2); // 保留前2行（空行+表头）
    const dataLines = allLines.slice(2).filter(l => l.trim());

    // 添加新行到数据行开头（最新的在上面）
    dataLines.unshift(newLine);

    // 保持最近 15 条
    if (dataLines.length > 15) {
      dataLines.pop();
    }

    this.transactionsBox.setContent(headerLines.join('\n') + '\n' + dataLines.join('\n'));
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
    const currentRound = this.engine.getRoundManager().getCurrentRoundSlug();
    const config = this.engine.getConfig();

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
      `  {bold}Engine:{/bold} ${isRunning ? '{green-fg}● RUNNING{/green-fg}' : '{red-fg}○ STOPPED{/red-fg}'}`,
      `  {bold}State:{/bold}  {${stateColor[currentState]}-fg}${currentState}{/${stateColor[currentState]}-fg}`,
      `  {bold}Market:{/bold} ${currentRound || 'N/A'}`,
      '',
      '  {cyan-fg}─── Config ───{/cyan-fg}',
      `  Shares: {bold}${config.shares}{/bold}`,
      `  Target: {bold}${config.sumTarget}{/bold}`,
      `  Move %: {bold}${(config.movePct * 100).toFixed(1)}%{/bold}`,
      `  Window: {bold}${config.windowMin}m{/bold}`,
      '',
      `  {gray-fg}Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}{/gray-fg}`,
      `  {gray-fg}${new Date().toLocaleTimeString()}{/gray-fg}`,
    ].join('\n');

    this.statusBox.setContent(content);
    this.screen.render();
  }

  /**
   * 添加日志 (保留兼容性)
   */
  public log(message: string): void {
    logger.info(message.replace(/\{[^}]+\}/g, '')); // 移除标签记录到日志
  }

  /**
   * 更新所有显示
   */
  private updateAll(): void {
    this.updateStatus();
    this.updateMarketInfo();
    this.updateOrderBook();
    if (this.priceHistory.length > 0) {
      const latest = this.priceHistory[this.priceHistory.length - 1];
      this.updateMarketAnalysis(latest);
      this.updatePositions(latest);
    }
  }

  /**
   * 启动 Dashboard
   */
  public start(): void {
    this.updateStatus();
    this.updateMarketInfo();
    this.updateOrderBook();
    this.updateAll();
    this.screen.render();

    // 初始化交易列表表头 (v0.3.0: 显示市场交易)
    const header = '\n  {cyan-fg}TIME       TOKEN  SIDE   PRICE   SIZE{/cyan-fg}\n';
    this.transactionsBox.setContent(header);

    // 定期刷新状态和市场信息（每秒更新剩余时间显示）
    setInterval(() => {
      this.updateStatus();
      this.updateMarketInfo();
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
        return;
      }

      const shares = parseFloat(value);
      if (isNaN(shares) || shares <= 0) {
        return;
      }

      try {
        await this.engine!.manualBuy(side, shares, true);

        // 更新模拟持仓
        const price = side === 'UP'
          ? (this.priceHistory[this.priceHistory.length - 1]?.upBestAsk || 0)
          : (this.priceHistory[this.priceHistory.length - 1]?.downBestAsk || 0);

        if (side === 'UP') {
          this.positions.up.shares += shares;
          this.positions.up.totalCost += shares * price;
          this.positions.up.avgCost = this.positions.up.totalCost / this.positions.up.shares;
        } else {
          this.positions.down.shares += shares;
          this.positions.down.totalCost += shares * price;
          this.positions.down.avgCost = this.positions.down.totalCost / this.positions.down.shares;
        }

        this.addTransaction('BUY', side, price, shares, 'manual');
      } catch (error) {
        logger.error('Manual buy failed', { side, shares, error });
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
          fg: THEME.primary,
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
        focus: { bg: 'green' },
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
        focus: { bg: 'green' },
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
        focus: { bg: 'green' },
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
        focus: { bg: 'green' },
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
        focus: { bg: 'cyan' },
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
        focus: { bg: 'magenta' },
      },
    });

    // 事件处理
    saveBtn.on('press', () => {
      const newShares = parseFloat(sharesInput.getValue() || String(config.shares));
      const newSumTarget = parseFloat(sumTargetInput.getValue() || String(config.sumTarget));
      const newMovePct = parseFloat(movePctInput.getValue() || String(config.movePct * 100)) / 100;
      const newWindowMin = parseFloat(windowMinInput.getValue() || String(config.windowMin));

      // 验证
      if (isNaN(newShares) || newShares <= 0) return;
      if (isNaN(newSumTarget) || newSumTarget < 0.5 || newSumTarget > 1.0) return;
      if (isNaN(newMovePct) || newMovePct < 0.01 || newMovePct > 0.30) return;
      if (isNaN(newWindowMin) || newWindowMin < 1 || newWindowMin > 15) return;

      // 更新配置
      this.engine!.updateConfig({
        shares: newShares,
        sumTarget: newSumTarget,
        movePct: newMovePct,
        windowMin: newWindowMin,
      });

      form.destroy();
      this.screen.render();
      this.updateStatus();
    });

    cancelBtn.on('press', () => {
      form.destroy();
      this.screen.render();
    });

    // ESC 关闭
    form.key(['escape'], () => {
      form.destroy();
      this.screen.render();
    });

    sharesInput.focus();
    this.screen.render();
  }
}
