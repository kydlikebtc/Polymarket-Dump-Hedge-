/**
 * 专业交易仪表盘
 * v0.2.0: 基于用户需求设计的专业级 UI
 *
 * 面板布局:
 * ┌──────────────────────────────────────────────────────────────┐
 * │                      标题栏 (市场 + 倒计时)                      │
 * ├─────────────────────┬───────────────────┬────────────────────┤
 * │    持仓面板          │   市场分析面板     │    订单簿面板       │
 * │  - UP 持仓/PnL      │  - Combined      │  - UP Asks/Bids    │
 * │  - DOWN 持仓/PnL    │  - Spread        │  - DOWN Asks/Bids  │
 * │  - 总 PnL           │  - Delta         │                    │
 * ├─────────────────────┴───────────────────┴────────────────────┤
 * │                     最近交易记录                              │
 * ├──────────────────────────────────────────────────────────────┤
 * │                     状态栏 + 快捷键                           │
 * └──────────────────────────────────────────────────────────────┘
 */

import type * as BlessedTypes from 'blessed';
import * as blessedModule from 'blessed';
import { TradingEngine } from '../core/index.js';

// ESM/CommonJS 兼容性处理：blessed 使用 CommonJS 导出，需要通过 default 访问
const blessed: typeof BlessedTypes = (blessedModule as any).default || blessedModule;
import { eventBus } from '../utils/EventBus.js';
import { logger } from '../utils/logger.js';
import type { Btc15mMarket } from '../api/MarketDiscoveryService.js';
import type {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
  Side,
  Btc15mMarketInfo,
} from '../types/index.js';

// 持仓信息
interface PositionInfo {
  side: Side;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
}

// 最近交易
interface RecentTrade {
  time: Date;
  side: Side;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  pnl?: number;
}

export class TradingDashboard {
  private screen: BlessedTypes.Widgets.Screen;

  // 顶部区域
  private headerBox: BlessedTypes.Widgets.BoxElement;

  // 中间区域 - 三列布局
  private positionsBox: BlessedTypes.Widgets.BoxElement;
  private marketAnalysisBox: BlessedTypes.Widgets.BoxElement;
  private orderBookBox: BlessedTypes.Widgets.BoxElement;

  // 底部区域
  private recentTradesBox: BlessedTypes.Widgets.BoxElement;
  private statusBar: BlessedTypes.Widgets.BoxElement;

  // 数据状态
  private engine: TradingEngine | null = null;
  private currentMarket: Btc15mMarket | null = null;
  private lastSnapshot: PriceSnapshot | null = null;
  private positions: Map<Side, PositionInfo> = new Map();
  private recentTrades: RecentTrade[] = [];
  private totalRealizedPnL: number = 0;

  // 刷新定时器
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'BTC 15m Trading Dashboard',
      fullUnicode: true,
    });

    // 创建所有面板
    this.headerBox = this.createHeaderBox();
    this.positionsBox = this.createPositionsBox();
    this.marketAnalysisBox = this.createMarketAnalysisBox();
    this.orderBookBox = this.createOrderBookBox();
    this.recentTradesBox = this.createRecentTradesBox();
    this.statusBar = this.createStatusBar();

    // 添加到屏幕
    this.screen.append(this.headerBox);
    this.screen.append(this.positionsBox);
    this.screen.append(this.marketAnalysisBox);
    this.screen.append(this.orderBookBox);
    this.screen.append(this.recentTradesBox);
    this.screen.append(this.statusBar);

    // 初始化持仓
    this.positions.set('UP', {
      side: 'UP',
      shares: 0,
      avgPrice: 0,
      currentPrice: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
    });
    this.positions.set('DOWN', {
      side: 'DOWN',
      shares: 0,
      avgPrice: 0,
      currentPrice: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
    });

    this.setupKeyBindings();
    this.setupEventListeners();

    logger.info('TradingDashboard initialized');
  }

  // ========== 面板创建 ==========

  private createHeaderBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue',
        bold: true,
      },
    });
  }

  private createPositionsBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: 0,
      width: '33%',
      height: 12,
      label: ' Positions ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' },
        label: { fg: 'cyan', bold: true },
      },
    });
  }

  private createMarketAnalysisBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: '33%',
      width: '34%',
      height: 12,
      label: ' Market Analysis ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'green' },
        label: { fg: 'green', bold: true },
      },
    });
  }

  private createOrderBookBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 3,
      left: '67%',
      width: '33%',
      height: 12,
      label: ' Order Book ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'yellow' },
        label: { fg: 'yellow', bold: true },
      },
    });
  }

  private createRecentTradesBox(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      top: 15,
      left: 0,
      width: '100%',
      height: '100%-18',
      label: ' Recent Trades ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'magenta' },
        label: { fg: 'magenta', bold: true },
      },
      scrollable: true,
      mouse: true,
    });
  }

  private createStatusBar(): BlessedTypes.Widgets.BoxElement {
    return blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      style: {
        fg: 'white',
        bg: 'black',
      },
    });
  }

  // ========== 事件设置 ==========

  private setupKeyBindings(): void {
    // 退出
    this.screen.key(['q', 'C-c'], () => {
      this.destroy();
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
      this.updateStatusBar();
    });

    // 手动买入 UP
    this.screen.key(['u'], async () => {
      await this.handleManualBuy('UP');
    });

    // 手动买入 DOWN
    this.screen.key(['d'], async () => {
      await this.handleManualBuy('DOWN');
    });

    // 刷新市场
    this.screen.key(['r'], async () => {
      await this.refreshMarket();
    });

    // 帮助
    this.screen.key(['h', '?'], () => {
      this.showHelp();
    });
  }

  private setupEventListeners(): void {
    // 价格更新
    eventBus.onEvent('price:update', (snapshot: PriceSnapshot) => {
      this.lastSnapshot = snapshot;
      this.updatePositionsFromSnapshot(snapshot);
      this.updateMarketAnalysis();
      this.updateOrderBook();
    });

    // 暴跌信号
    eventBus.onEvent('price:dump_detected', (signal: DumpSignal) => {
      this.addRecentTrade({
        time: new Date(),
        side: signal.side,
        action: 'BUY',
        price: signal.price,
        shares: 0, // 信号，非实际交易
      });
    });

    // 订单成交
    eventBus.onEvent('order:filled', (order: Order) => {
      this.addRecentTrade({
        time: new Date(),
        side: order.side,
        action: 'BUY',
        price: order.avgFillPrice || 0,
        shares: order.shares,
      });
      this.updatePositionFromOrder(order);
    });

    // 交易周期完成
    eventBus.onEvent('cycle:completed', ({ cycle, profit }: { cycle: TradeCycle; profit: number }) => {
      this.totalRealizedPnL += profit;
      if (cycle.leg2) {
        this.addRecentTrade({
          time: new Date(),
          side: cycle.leg2.side,
          action: 'SELL',
          price: cycle.leg2.entryPrice,
          shares: cycle.leg2.shares,
          pnl: profit,
        });
      }
    });

    // 市场发现
    eventBus.onEvent('market:discovered', (market: Btc15mMarketInfo) => {
      this.currentMarket = market as Btc15mMarket;
      this.updateHeader();
    });

    // 市场切换
    eventBus.onEvent('market:switched', (market: Btc15mMarketInfo) => {
      this.currentMarket = market as Btc15mMarket;
      this.resetPositions();
      this.updateHeader();
    });

    // 轮次事件
    eventBus.onEvent('round:new', () => {
      this.updateHeader();
    });

    eventBus.onEvent('round:ending', () => {
      this.updateHeader();
    });

    // WebSocket 事件
    eventBus.onEvent('ws:connected', () => {
      this.updateStatusBar();
    });

    eventBus.onEvent('ws:disconnected', () => {
      this.updateStatusBar();
    });
  }

  // ========== 更新方法 ==========

  private updateHeader(): void {
    const round = this.engine?.getRoundManager();
    const remaining = round?.getSecondsRemaining() || 0;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    const marketSlug = this.currentMarket?.slug || round?.getCurrentRoundSlug() || 'N/A';

    // 根据剩余时间设置颜色
    let timeColor = 'white';
    if (remaining <= 30) {
      timeColor = 'red';
    } else if (remaining <= 60) {
      timeColor = 'yellow';
    }

    const isRunning = this.engine?.isEngineRunning() ?? false;
    const statusIcon = isRunning ? '{green-fg}●{/green-fg}' : '{red-fg}○{/red-fg}';

    this.headerBox.setContent(
      `  ${statusIcon} {bold}BTC 15m Trading Dashboard{/bold}` +
      `  |  Market: {cyan-fg}${marketSlug}{/cyan-fg}` +
      `  |  Time: {${timeColor}-fg}{bold}${timeStr}{/${timeColor}-fg}{/bold}` +
      `  |  Auto-Rotate: {green-fg}ON{/green-fg}`
    );

    this.screen.render();
  }

  private updatePositions(): void {
    const upPos = this.positions.get('UP')!;
    const downPos = this.positions.get('DOWN')!;

    const totalUnrealized = upPos.unrealizedPnL + downPos.unrealizedPnL;
    const totalPnL = this.totalRealizedPnL + totalUnrealized;

    const formatPnL = (pnl: number): string => {
      if (pnl >= 0) {
        return `{green-fg}+$${pnl.toFixed(4)}{/green-fg}`;
      }
      return `{red-fg}-$${Math.abs(pnl).toFixed(4)}{/red-fg}`;
    };

    const formatPrice = (price: number): string => {
      return price.toFixed(4);
    };

    const lines = [
      '',
      ' {bold}UP Position{/bold}',
      `   Shares: ${upPos.shares}`,
      `   Avg:    ${formatPrice(upPos.avgPrice)}`,
      `   Now:    ${formatPrice(upPos.currentPrice)}`,
      `   PnL:    ${formatPnL(upPos.unrealizedPnL)}`,
      '',
      ' {bold}DOWN Position{/bold}',
      `   Shares: ${downPos.shares}`,
      `   Avg:    ${formatPrice(downPos.avgPrice)}`,
      `   Now:    ${formatPrice(downPos.currentPrice)}`,
      `   PnL:    ${formatPnL(downPos.unrealizedPnL)}`,
      '',
      ' ─────────────────',
      ` {bold}Total PnL:{/bold} ${formatPnL(totalPnL)}`,
    ];

    this.positionsBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  private updatePositionsFromSnapshot(snapshot: PriceSnapshot): void {
    const upPos = this.positions.get('UP')!;
    const downPos = this.positions.get('DOWN')!;

    upPos.currentPrice = snapshot.upBestBid;
    downPos.currentPrice = snapshot.downBestBid;

    // 计算未实现盈亏
    if (upPos.shares > 0) {
      upPos.unrealizedPnL = (upPos.currentPrice - upPos.avgPrice) * upPos.shares;
    }
    if (downPos.shares > 0) {
      downPos.unrealizedPnL = (downPos.currentPrice - downPos.avgPrice) * downPos.shares;
    }

    this.updatePositions();
  }

  private updatePositionFromOrder(order: Order): void {
    const pos = this.positions.get(order.side)!;

    if (order.avgFillPrice && order.shares > 0) {
      // 计算新的平均价格
      const totalValue = pos.avgPrice * pos.shares + order.avgFillPrice * order.shares;
      const totalShares = pos.shares + order.shares;
      pos.avgPrice = totalShares > 0 ? totalValue / totalShares : 0;
      pos.shares = totalShares;
    }

    this.updatePositions();
  }

  private resetPositions(): void {
    this.positions.set('UP', {
      side: 'UP',
      shares: 0,
      avgPrice: 0,
      currentPrice: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
    });
    this.positions.set('DOWN', {
      side: 'DOWN',
      shares: 0,
      avgPrice: 0,
      currentPrice: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
    });
    this.updatePositions();
  }

  private updateMarketAnalysis(): void {
    if (!this.lastSnapshot) {
      this.marketAnalysisBox.setContent('\n  Waiting for data...');
      this.screen.render();
      return;
    }

    const snapshot = this.lastSnapshot;

    // 计算核心指标
    const combined = snapshot.upBestAsk + snapshot.downBestAsk;
    const upSpread = snapshot.upBestAsk - snapshot.upBestBid;
    const downSpread = snapshot.downBestAsk - snapshot.downBestBid;
    const avgSpread = (upSpread + downSpread) / 2;
    const delta = snapshot.upBestAsk - snapshot.downBestAsk;

    // 颜色逻辑
    const combinedColor = combined < 0.95 ? 'green' : combined < 0.98 ? 'yellow' : 'red';
    const spreadColor = avgSpread < 0.02 ? 'green' : avgSpread < 0.05 ? 'yellow' : 'red';
    const deltaColor = Math.abs(delta) < 0.1 ? 'white' : delta > 0 ? 'green' : 'red';

    // 价格柱状图
    const upBarLen = Math.floor(snapshot.upBestAsk * 15);
    const downBarLen = Math.floor(snapshot.downBestAsk * 15);
    const upBar = '█'.repeat(upBarLen) + '░'.repeat(15 - upBarLen);
    const downBar = '█'.repeat(downBarLen) + '░'.repeat(15 - downBarLen);

    const lines = [
      '',
      ' {bold}Prices{/bold}',
      ` UP   {green-fg}${upBar}{/green-fg} ${snapshot.upBestAsk.toFixed(4)}`,
      ` DOWN {red-fg}${downBar}{/red-fg} ${snapshot.downBestAsk.toFixed(4)}`,
      '',
      ' {bold}Indicators{/bold}',
      ` Combined: {${combinedColor}-fg}{bold}${combined.toFixed(4)}{/bold}{/${combinedColor}-fg}`,
      ` Spread:   {${spreadColor}-fg}${(avgSpread * 100).toFixed(2)}%{/${spreadColor}-fg}`,
      ` Delta:    {${deltaColor}-fg}${delta >= 0 ? '+' : ''}${delta.toFixed(4)}{/${deltaColor}-fg}`,
      '',
      ` {gray-fg}UP Bid/Ask:   ${snapshot.upBestBid.toFixed(4)}/${snapshot.upBestAsk.toFixed(4)}{/gray-fg}`,
      ` {gray-fg}DOWN Bid/Ask: ${snapshot.downBestBid.toFixed(4)}/${snapshot.downBestAsk.toFixed(4)}{/gray-fg}`,
    ];

    this.marketAnalysisBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  private updateOrderBook(): void {
    if (!this.lastSnapshot) {
      this.orderBookBox.setContent('\n  Waiting for data...');
      this.screen.render();
      return;
    }

    const snapshot = this.lastSnapshot;

    // 模拟订单簿数据 (实际应从 WebSocket 获取完整深度)
    const upAsks = [
      { price: snapshot.upBestAsk, size: 100 },
      { price: snapshot.upBestAsk + 0.01, size: 200 },
      { price: snapshot.upBestAsk + 0.02, size: 150 },
    ];
    const upBids = [
      { price: snapshot.upBestBid, size: 120 },
      { price: snapshot.upBestBid - 0.01, size: 180 },
      { price: snapshot.upBestBid - 0.02, size: 90 },
    ];

    const downAsks = [
      { price: snapshot.downBestAsk, size: 110 },
      { price: snapshot.downBestAsk + 0.01, size: 170 },
      { price: snapshot.downBestAsk + 0.02, size: 130 },
    ];
    const downBids = [
      { price: snapshot.downBestBid, size: 100 },
      { price: snapshot.downBestBid - 0.01, size: 160 },
      { price: snapshot.downBestBid - 0.02, size: 80 },
    ];

    const formatLevel = (price: number, size: number, color: string): string => {
      return `{${color}-fg}${price.toFixed(3)}{/${color}-fg} ${size.toString().padStart(4)}`;
    };

    const lines = [
      '',
      ' {bold}UP{/bold}         {bold}DOWN{/bold}',
      ' Ask         Ask',
    ];

    // Asks (卖单)
    for (let i = 0; i < 3; i++) {
      const upAsk = upAsks[i];
      const downAsk = downAsks[i];
      lines.push(` ${formatLevel(upAsk.price, upAsk.size, 'red')}  ${formatLevel(downAsk.price, downAsk.size, 'red')}`);
    }

    lines.push(' ─────────────────');

    // Bids (买单)
    for (let i = 0; i < 3; i++) {
      const upBid = upBids[i];
      const downBid = downBids[i];
      lines.push(` ${formatLevel(upBid.price, upBid.size, 'green')}  ${formatLevel(downBid.price, downBid.size, 'green')}`);
    }

    lines.push(' Bid         Bid');

    this.orderBookBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  private addRecentTrade(trade: RecentTrade): void {
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > 20) {
      this.recentTrades.pop();
    }
    this.updateRecentTrades();
  }

  private updateRecentTrades(): void {
    if (this.recentTrades.length === 0) {
      this.recentTradesBox.setContent('\n  No trades yet...');
      this.screen.render();
      return;
    }

    const lines = [''];
    const header = ' Time       Side   Action  Price    Shares   PnL';
    lines.push(header);
    lines.push(' ' + '─'.repeat(55));

    for (const trade of this.recentTrades.slice(0, 10)) {
      const time = trade.time.toLocaleTimeString('en-US', { hour12: false });
      const sideColor = trade.side === 'UP' ? 'green' : 'red';
      const actionColor = trade.action === 'BUY' ? 'cyan' : 'yellow';
      const pnlStr = trade.pnl !== undefined
        ? (trade.pnl >= 0 ? `{green-fg}+${trade.pnl.toFixed(2)}{/green-fg}` : `{red-fg}${trade.pnl.toFixed(2)}{/red-fg}`)
        : '-';

      lines.push(
        ` ${time}  ` +
        `{${sideColor}-fg}${trade.side.padEnd(5)}{/${sideColor}-fg}  ` +
        `{${actionColor}-fg}${trade.action.padEnd(5)}{/${actionColor}-fg}  ` +
        `${trade.price.toFixed(4)}  ` +
        `${trade.shares.toString().padStart(6)}   ` +
        pnlStr
      );
    }

    this.recentTradesBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  private updateStatusBar(): void {
    const isRunning = this.engine?.isEngineRunning() ?? false;
    const wsConnected = true; // TODO: 从引擎获取实际状态
    const currentState = this.engine?.getStateMachine()?.getCurrentStatus() || 'N/A';

    const statusColor = isRunning ? 'green' : 'red';
    const wsColor = wsConnected ? 'green' : 'red';

    const stateColors: Record<string, string> = {
      'IDLE': 'white',
      'WATCHING': 'cyan',
      'LEG1_PENDING': 'yellow',
      'LEG1_FILLED': 'green',
      'LEG2_PENDING': 'yellow',
      'COMPLETED': 'green',
      'ROUND_EXPIRED': 'red',
      'ERROR': 'red',
    };
    const stateColor = stateColors[currentState] || 'white';

    this.statusBar.setContent(
      `  Status: {${statusColor}-fg}${isRunning ? 'Running' : 'Stopped'}{/${statusColor}-fg}` +
      `  |  WS: {${wsColor}-fg}${wsConnected ? 'Connected' : 'Disconnected'}{/${wsColor}-fg}` +
      `  |  State: {${stateColor}-fg}${currentState}{/${stateColor}-fg}` +
      `  |  {gray-fg}[q]Quit [s]Start/Stop [u]Buy UP [d]Buy DOWN [r]Refresh [h]Help{/gray-fg}`
    );

    this.screen.render();
  }

  // ========== 交互方法 ==========

  private async handleManualBuy(side: Side): Promise<void> {
    if (!this.engine) {
      logger.warn('Engine not initialized');
      return;
    }

    const prompt = blessed.prompt({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      label: ` Buy ${side} `,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: side === 'UP' ? 'green' : 'red' },
      },
    });

    prompt.input('Enter shares amount:', '', async (err, value) => {
      prompt.destroy();
      this.screen.render();

      if (err || !value) return;

      const shares = parseFloat(value);
      if (isNaN(shares) || shares <= 0) {
        logger.warn('Invalid shares amount', { value });
        return;
      }

      try {
        await this.engine!.manualBuy(side, shares, true);
        logger.info('Manual buy executed', { side, shares });
      } catch (error) {
        logger.error('Manual buy failed', {
          side,
          shares,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.screen.render();
  }

  private async refreshMarket(): Promise<void> {
    if (!this.engine) return;

    const round = this.engine.getRoundManager();
    if (round.isAutoDiscoverEnabled()) {
      await round.refreshMarketDiscovery();
      logger.info('Market discovery refreshed');
    }
  }

  private showHelp(): void {
    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '60%',
      label: ' Help ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' },
      },
      scrollable: true,
      mouse: true,
    });

    helpBox.setContent(`
  {bold}BTC 15m Trading Dashboard - Help{/bold}

  {cyan-fg}Keyboard Shortcuts:{/cyan-fg}

    q, Ctrl+C   Exit the application
    s           Start/Stop trading engine
    u           Manual buy UP
    d           Manual buy DOWN
    r           Refresh market discovery
    h, ?        Show this help

  {cyan-fg}Panels:{/cyan-fg}

    Positions      Shows your current holdings and PnL
    Market Analysis  Real-time price data and indicators
    Order Book     Bid/Ask levels for UP and DOWN
    Recent Trades  Your trading history

  {cyan-fg}Features (v0.2.0):{/cyan-fg}

    - Auto-rotation: Automatically switches to new
      BTC 15m markets when current round expires
    - Real-time data: Live price updates via WebSocket
    - PnL tracking: Unrealized and realized profit/loss

  {gray-fg}Press ESC or Enter to close{/gray-fg}
`);

    helpBox.key(['escape', 'enter', 'q'], () => {
      helpBox.destroy();
      this.screen.render();
    });

    helpBox.focus();
    this.screen.render();
  }

  // ========== 公共方法 ==========

  public setEngine(engine: TradingEngine): void {
    this.engine = engine;

    // 获取当前市场
    const round = engine.getRoundManager();
    const discoveredMarket = round.getCurrentDiscoveredMarket();
    if (discoveredMarket) {
      this.currentMarket = discoveredMarket;
    }

    this.updateHeader();
    this.updateStatusBar();
  }

  public start(): void {
    logger.info('TradingDashboard started');

    // 初始更新
    this.updateHeader();
    this.updatePositions();
    this.updateMarketAnalysis();
    this.updateOrderBook();
    this.updateRecentTrades();
    this.updateStatusBar();

    // 定期刷新
    this.refreshInterval = setInterval(() => {
      this.updateHeader();
      this.updateStatusBar();
    }, 1000);

    this.screen.render();
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.screen.destroy();
    logger.info('TradingDashboard destroyed');
  }
}

export default TradingDashboard;
