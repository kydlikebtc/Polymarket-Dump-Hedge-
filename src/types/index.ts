/**
 * Polymarket Dump & Hedge - 类型定义
 */

// ===== 配置类型 =====

export interface BotConfig {
  // 交易参数
  shares: number;              // 每笔份数
  sumTarget: number;           // 对冲阈值 (0.5 - 1.0)
  movePct: number;             // 暴跌检测阈值 (0.01 - 0.30)
  windowMin: number;           // 监控窗口分钟数 (1 - 15)

  // 网络配置
  wsUrl: string;               // Polymarket WebSocket URL
  apiUrl: string;              // Polymarket REST API URL
  reconnectDelay: number;      // 重连延迟(ms)
  maxReconnects: number;       // 最大重连次数

  // 费用参数
  feeRate: number;             // 手续费率
  spreadBuffer: number;        // 滑点缓冲

  // 钱包配置
  privateKey: string;          // 私钥
  walletAddress: string;       // 钱包地址

  // Builder API 配置 (可选，用于订单归因)
  builderApiKey?: string;      // Builder API Key
  builderSecret?: string;      // Builder Secret
  builderPassphrase?: string;  // Builder Passphrase

  // 运行模式
  readOnly: boolean;           // 只读模式
  dryRun: boolean;             // 模拟模式
}

// ===== 价格数据类型 =====

export interface PriceSnapshot {
  timestamp: number;           // Unix毫秒时间戳
  roundSlug: string;           // 轮次标识
  secondsRemaining: number;    // 轮次剩余秒数
  upTokenId: string;           // UP Token ID
  downTokenId: string;         // DOWN Token ID
  upBestAsk: number;           // UP最优卖价
  upBestBid: number;           // UP最优买价
  downBestAsk: number;         // DOWN最优卖价
  downBestBid: number;         // DOWN最优买价
}

export interface MarketInfo {
  roundSlug: string;
  upTokenId: string;
  downTokenId: string;
  startTime: number;
  endTime: number;
  status: 'active' | 'resolved' | 'pending';
}

// ===== 暴跌检测类型 =====

export type Side = 'UP' | 'DOWN';

export interface DumpSignal {
  side: Side;
  dropPct: number;             // 下跌百分比
  price: number;               // 当前价格
  previousPrice: number;       // 之前价格
  timestamp: number;
  roundSlug: string;
}

// ===== 订单类型 =====

export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';

export interface Order {
  id: string;
  cycleId?: string;
  side: Side;
  orderType: OrderType;
  shares: number;
  price?: number;              // Limit order price
  avgFillPrice?: number;
  totalCost?: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  error?: string;
}

export interface OrderResult {
  orderId: string;
  side: Side;
  shares: number;
  avgPrice: number;
  totalCost: number;
  status: 'filled' | 'partial' | 'pending' | 'rejected';
  timestamp: number;
  error?: string;
}

// ===== 交易周期类型 =====

export type CycleStatus =
  | 'IDLE'           // 初始状态，等待新轮次
  | 'WATCHING'       // 监控价格，等待暴跌信号
  | 'LEG1_PENDING'   // Leg 1订单已提交，等待成交
  | 'LEG1_FILLED'    // Leg 1已成交，等待对冲条件
  | 'LEG2_PENDING'   // Leg 2订单已提交，等待成交
  | 'COMPLETED'      // 双腿完成
  | 'ROUND_EXPIRED'  // 轮次结束
  | 'ERROR';         // 错误状态

export interface LegInfo {
  orderId: string;
  side: Side;
  shares: number;
  entryPrice: number;
  totalCost: number;
  filledAt: number;
}

export interface TradeCycle {
  id: string;
  roundSlug: string;
  status: CycleStatus;
  leg1?: LegInfo;
  leg2?: LegInfo;
  profit?: number;
  guaranteedProfit?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ===== 状态机类型 =====

export interface StateTransition {
  from: CycleStatus;
  to: CycleStatus;
  event: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

// ===== 事件类型 =====

export interface BotEvents {
  // WebSocket 事件
  'ws:connected': void;
  'ws:disconnected': { code: number; reason: string };
  'ws:error': Error;
  'ws:reconnecting': { attempt: number };

  // 价格事件
  'price:update': PriceSnapshot;
  'price:dump_detected': DumpSignal;

  // 轮次事件
  'round:new': { roundSlug: string; startTime: number };
  'round:ending': { roundSlug: string; secondsRemaining: number };
  'round:expired': { roundSlug: string };

  // 订单事件
  'order:submitted': Order;
  'order:filled': Order;
  'order:cancelled': Order;
  'order:error': { order: Order; error: Error };

  // 周期事件
  'cycle:started': TradeCycle;
  'cycle:leg1_filled': { cycle: TradeCycle; leg: LegInfo };
  'cycle:leg2_filled': { cycle: TradeCycle; leg: LegInfo };
  'cycle:completed': { cycle: TradeCycle; profit: number };
  'cycle:expired': TradeCycle;
  'cycle:error': { cycle: TradeCycle; error: Error };

  // 系统事件
  'system:error': Error;
  'system:warning': string;
  'system:info': string;

  // 告警事件
  'alert:sent': Alert;
}

// ===== 回测类型 =====

export interface BacktestConfig {
  startTime: number;
  endTime: number;
  shares: number;
  sumTarget: number;
  movePct: number;
  windowMin: number;
  initialCapital: number;
  feeRate: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: TradeCycle[];
  metrics: BacktestMetrics;
  equityCurve: { timestamp: number; equity: number }[];
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgTrade: number;
  finalEquity: number;
  returnPct: number;
}

// ===== 日志类型 =====

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

// ===== 告警类型 =====

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

// ===== 告警配置类型 =====

export interface AlertChannelConfig {
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
}

export interface AlertConfig {
  channels: AlertChannelConfig;
  minSeverity: AlertSeverity;
  throttle: {
    enabled: boolean;
    windowMs: number;
    maxPerWindow: number;
  };
  quietHours?: {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timezone: string;
  };
}
