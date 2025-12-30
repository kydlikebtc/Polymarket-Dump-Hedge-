# Polymarket Dump & Hedge 自动化交易系统
## 技术设计文档 (TDD)

**文档版本**: v1.0  
**创建日期**: 2025年12月30日  
**作者**: Kyd  
**状态**: Draft

---

## 1. 系统概述

### 1.1 设计目标
构建一个高性能、低延迟的Polymarket自动化交易系统，实现"暴跌接针+无风险对冲"(Dump & Hedge)策略的全自动执行。

### 1.2 设计原则
- **低延迟优先**: 所有关键路径优化至毫秒级
- **容错设计**: 网络异常、API错误不影响系统稳定性
- **模块解耦**: 各组件独立，便于测试和维护
- **状态可追溯**: 完整的状态机管理和日志记录

### 1.3 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js / Rust | JS快速开发，Rust高性能生产 |
| WebSocket | ws / tokio-tungstenite | 原生WebSocket支持 |
| 状态管理 | 有限状态机 (FSM) | 清晰的状态转换逻辑 |
| 数据存储 | SQLite | 轻量级本地持久化 |
| 配置管理 | dotenv + JSON | 灵活的多环境配置 |
| 日志 | Winston / tracing | 结构化日志输出 |

---

## 2. 系统架构

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Polymarket Bot System                         │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Terminal  │  │   Config    │  │    Logger   │  │   Alerter   │ │
│  │     UI      │  │   Manager   │  │   Service   │  │   Service   │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │        │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐ │
│  │                      Event Bus (EventEmitter)                   │ │
│  └──────┬────────────────┬────────────────┬────────────────┬──────┘ │
│         │                │                │                │        │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐ │
│  │   Market    │  │   Dump      │  │   Order     │  │   Round     │ │
│  │  Watcher    │  │  Detector   │  │  Executor   │  │  Manager    │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │        │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐ │
│  │                     State Machine (FSM)                         │ │
│  └──────┬────────────────────────────────────────────────────┬────┘ │
│         │                                                    │      │
│  ┌──────┴──────┐                                      ┌──────┴────┐ │
│  │  WebSocket  │                                      │  SQLite   │ │
│  │   Client    │                                      │    DB     │ │
│  └──────┬──────┘                                      └───────────┘ │
└─────────┼───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Polymarket CLOB    │
│       API           │
└─────────────────────┘
```

### 2.2 核心组件

#### 2.2.1 Market Watcher (价格监控器)
**职责**: 维护WebSocket连接，接收实时价格更新

**核心逻辑**:
```javascript
class MarketWatcher {
  constructor(config) {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.priceBuffer = new CircularBuffer(100); // 最近100个价格
  }

  async connect() {
    this.ws = new WebSocket(POLYMARKET_WS_URL);
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('close', this.handleDisconnect.bind(this));
  }

  handleMessage(data) {
    const tick = JSON.parse(data);
    const snapshot = {
      timestamp: Date.now(),
      roundSlug: tick.roundSlug,
      secondsRemaining: tick.secondsRemaining,
      upTokenId: tick.upTokenId,
      downTokenId: tick.downTokenId,
      upBestAsk: parseFloat(tick.upBestAsk),
      downBestAsk: parseFloat(tick.downBestAsk)
    };
    this.priceBuffer.push(snapshot);
    this.emit('price_update', snapshot);
  }
}
```

#### 2.2.2 Dump Detector (暴跌检测器)
**职责**: 分析价格变动，识别暴跌信号

**检测算法**:
```javascript
class DumpDetector {
  constructor(config) {
    this.movePct = config.movePct;        // 默认 0.15 (15%)
    this.windowSeconds = 3;                // 检测窗口3秒
    this.windowMin = config.windowMin;     // 轮次开始后监控时长
  }

  detect(priceBuffer, currentRoundStart) {
    const now = Date.now();
    const windowStart = now - (this.windowSeconds * 1000);
    
    // 检查是否在监控窗口内
    if ((now - currentRoundStart) > this.windowMin * 60 * 1000) {
      return null; // 超出监控窗口
    }

    // 获取窗口内价格
    const windowPrices = priceBuffer.filter(p => p.timestamp >= windowStart);
    if (windowPrices.length < 2) return null;

    const first = windowPrices[0];
    const last = windowPrices[windowPrices.length - 1];

    // 检测UP暴跌
    const upDrop = (first.upBestAsk - last.upBestAsk) / first.upBestAsk;
    if (upDrop >= this.movePct) {
      return { side: 'UP', dropPct: upDrop, price: last.upBestAsk };
    }

    // 检测DOWN暴跌
    const downDrop = (first.downBestAsk - last.downBestAsk) / first.downBestAsk;
    if (downDrop >= this.movePct) {
      return { side: 'DOWN', dropPct: downDrop, price: last.downBestAsk };
    }

    return null;
  }
}
```

#### 2.2.3 Order Executor (订单执行器)
**职责**: 与Polymarket API交互，执行买卖订单

**接口定义**:
```typescript
interface OrderExecutor {
  // 按USD金额买入
  buyByUsd(side: 'UP' | 'DOWN', usdAmount: number): Promise<OrderResult>;
  
  // 按份数买入 (Limit Order)
  buyByShares(side: 'UP' | 'DOWN', shares: number, price: number): Promise<OrderResult>;
  
  // 查询订单状态
  getOrderStatus(orderId: string): Promise<OrderStatus>;
  
  // 取消订单
  cancelOrder(orderId: string): Promise<boolean>;
}

interface OrderResult {
  orderId: string;
  side: 'UP' | 'DOWN';
  shares: number;
  avgPrice: number;
  totalCost: number;
  status: 'filled' | 'partial' | 'pending';
  timestamp: number;
}
```

#### 2.2.4 State Machine (状态机)
**职责**: 管理交易周期的状态转换

**状态定义**:
```
IDLE          → 初始状态，等待新轮次
WATCHING      → 监控价格，等待暴跌信号
LEG1_PENDING  → Leg 1订单已提交，等待成交
LEG1_FILLED   → Leg 1已成交，等待对冲条件
LEG2_PENDING  → Leg 2订单已提交，等待成交
COMPLETED     → 双腿完成，准备重置
ROUND_EXPIRED → 轮次结束，强制重置
```

---

## 3. 数据流设计

### 3.1 实时数据流

```
Polymarket WS API
       │
       ▼ (raw tick data)
┌──────────────┐
│MarketWatcher │────► PriceBuffer (CircularBuffer)
└──────┬───────┘              │
       │                      ▼
       │              ┌──────────────┐
       │              │DumpDetector  │
       │              └──────┬───────┘
       │                     │
       ▼                     ▼ (dump signal)
┌──────────────┐      ┌──────────────┐
│  EventBus    │◄─────│StateMachine  │
└──────┬───────┘      └──────┬───────┘
       │                     │
       ▼                     ▼
┌──────────────┐      ┌──────────────┐
│  TerminalUI  │      │OrderExecutor │
└──────────────┘      └──────────────┘
```

### 3.2 数据快照结构

```typescript
interface PriceSnapshot {
  timestamp: number;           // Unix毫秒时间戳
  roundSlug: string;           // 轮次标识 e.g. "btc-15m-up-down-2025-01-01-12-00"
  secondsRemaining: number;    // 轮次剩余秒数
  upTokenId: string;           // UP Token合约地址
  downTokenId: string;         // DOWN Token合约地址
  upBestAsk: number;           // UP最优卖价
  upBestBid: number;           // UP最优买价
  downBestAsk: number;         // DOWN最优卖价
  downBestBid: number;         // DOWN最优买价
}

interface CycleState {
  cycleId: string;             // 周期唯一ID
  roundSlug: string;           // 所属轮次
  status: CycleStatus;         // 当前状态
  leg1: LegInfo | null;        // Leg 1信息
  leg2: LegInfo | null;        // Leg 2信息
  profit: number | null;       // 最终盈亏
  createdAt: number;
  updatedAt: number;
}

interface LegInfo {
  orderId: string;
  side: 'UP' | 'DOWN';
  shares: number;
  entryPrice: number;
  totalCost: number;
  filledAt: number;
}
```

---

## 4. 核心算法

### 4.1 双腿对冲算法

```javascript
class HedgeStrategy {
  constructor(config) {
    this.sumTarget = config.sumTarget;  // 默认 0.95
    this.shares = config.shares;         // 每腿份数
  }

  /**
   * 计算是否满足对冲条件
   * @param leg1Price - Leg 1买入价格
   * @param oppositeAsk - 对手方当前ask价格
   * @returns boolean
   */
  shouldHedge(leg1Price, oppositeAsk) {
    return (leg1Price + oppositeAsk) <= this.sumTarget;
  }

  /**
   * 计算对冲后的保证收益
   * @param leg1Price - Leg 1买入价格
   * @param leg2Price - Leg 2买入价格
   * @param shares - 每腿份数
   * @returns 保证收益 (假设无手续费)
   */
  calculateGuaranteedProfit(leg1Price, leg2Price, shares) {
    const totalCost = (leg1Price + leg2Price) * shares;
    const guaranteedReturn = 1.0 * shares;  // 无论结果，赢的一方 = $1.00/share
    return guaranteedReturn - totalCost;
  }

  /**
   * 完整对冲流程
   */
  async executeHedgeCycle(dumpSignal, marketWatcher, orderExecutor) {
    // Step 1: 执行Leg 1 (买入暴跌方)
    const leg1Result = await orderExecutor.buyByShares(
      dumpSignal.side,
      this.shares,
      dumpSignal.price
    );
    
    const oppositeSide = dumpSignal.side === 'UP' ? 'DOWN' : 'UP';
    
    // Step 2: 等待对冲条件
    return new Promise((resolve) => {
      const checkHedge = (snapshot) => {
        const oppositeAsk = oppositeSide === 'UP' 
          ? snapshot.upBestAsk 
          : snapshot.downBestAsk;
        
        if (this.shouldHedge(leg1Result.avgPrice, oppositeAsk)) {
          marketWatcher.off('price_update', checkHedge);
          
          // Step 3: 执行Leg 2 (对冲)
          orderExecutor.buyByShares(oppositeSide, this.shares, oppositeAsk)
            .then(leg2Result => {
              const profit = this.calculateGuaranteedProfit(
                leg1Result.avgPrice,
                leg2Result.avgPrice,
                this.shares
              );
              resolve({ leg1: leg1Result, leg2: leg2Result, profit });
            });
        }
      };
      
      marketWatcher.on('price_update', checkHedge);
    });
  }
}
```

### 4.2 参数敏感性分析

| 参数 | 保守值 | 激进值 | 影响分析 |
|------|--------|--------|----------|
| sumTarget | 0.95 | 0.60 | 越低越容易触发Leg 2，但单笔利润更高 |
| movePct | 0.15 | 0.01 | 越低触发越频繁，但可能买在下跌中途 |
| windowMin | 2 | 15 | 越长机会越多，但后期波动可能不如开盘激烈 |
| shares | 20 | 100 | 影响单笔绝对收益和滑点 |

**推荐初始参数** (基于原始推文回测结果):
- sumTarget = 0.95
- movePct = 0.15 (15%)
- windowMin = 2
- shares = 20

---

## 5. 接口设计

### 5.1 配置接口

```typescript
interface BotConfig {
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
  
  // 费用参数 (用于计算)
  feeRate: number;             // 手续费率 (默认 0.005)
  spreadBuffer: number;        // 滑点缓冲 (默认 0.02)
  
  // 钱包配置
  privateKey: string;          // 私钥 (加密存储)
  walletAddress: string;       // 钱包地址
}
```

### 5.2 命令行接口

```
Commands:
  auto on <shares> [sum=0.95] [move=0.15] [windowMin=2]
                              # 启动自动模式
  auto off                    # 关闭自动模式
  
  buy up <usd>                # 按USD买入UP
  buy down <usd>              # 按USD买入DOWN
  buyshares up <shares>       # 按份数买入UP (Limit)
  buyshares down <shares>     # 按份数买入DOWN (Limit)
  
  status                      # 显示当前状态
  position                    # 显示持仓
  history [n]                 # 显示最近n笔交易
  
  set <param> <value>         # 修改参数
  config                      # 显示当前配置
  
  exit                        # 退出程序
```

---

## 6. 数据库设计

### 6.1 表结构

```sql
-- 价格快照表 (用于回测)
CREATE TABLE price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    round_slug TEXT NOT NULL,
    seconds_remaining INTEGER,
    up_best_ask REAL NOT NULL,
    down_best_ask REAL NOT NULL,
    up_best_bid REAL,
    down_best_bid REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_snapshots_timestamp ON price_snapshots(timestamp);
CREATE INDEX idx_snapshots_round ON price_snapshots(round_slug);

-- 交易周期表
CREATE TABLE trade_cycles (
    id TEXT PRIMARY KEY,
    round_slug TEXT NOT NULL,
    status TEXT NOT NULL,  -- IDLE, WATCHING, LEG1_FILLED, COMPLETED, EXPIRED
    
    leg1_order_id TEXT,
    leg1_side TEXT,        -- UP or DOWN
    leg1_shares REAL,
    leg1_price REAL,
    leg1_cost REAL,
    leg1_filled_at INTEGER,
    
    leg2_order_id TEXT,
    leg2_side TEXT,
    leg2_shares REAL,
    leg2_price REAL,
    leg2_cost REAL,
    leg2_filled_at INTEGER,
    
    profit REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 订单历史表
CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    cycle_id TEXT,
    side TEXT NOT NULL,
    order_type TEXT NOT NULL,  -- MARKET, LIMIT
    shares REAL NOT NULL,
    price REAL,
    avg_fill_price REAL,
    total_cost REAL,
    status TEXT NOT NULL,      -- PENDING, FILLED, PARTIAL, CANCELLED
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    filled_at DATETIME,
    FOREIGN KEY (cycle_id) REFERENCES trade_cycles(id)
);

-- 配置历史表 (用于回测对比)
CREATE TABLE config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shares REAL,
    sum_target REAL,
    move_pct REAL,
    window_min INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 7. 错误处理

### 7.1 错误分类

| 错误类型 | 处理策略 | 重试 |
|----------|----------|------|
| WebSocket断连 | 指数退避重连 | 是 |
| API限流 | 等待后重试 | 是 |
| 订单被拒 | 记录并告警 | 否 |
| 余额不足 | 暂停交易，告警 | 否 |
| 网络超时 | 重试3次 | 是 |
| 数据格式错误 | 记录并跳过 | 否 |

### 7.2 错误处理代码

```javascript
class ErrorHandler {
  static async withRetry(fn, maxRetries = 3, backoffMs = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxRetries) throw error;
        
        const delay = backoffMs * Math.pow(2, attempt - 1);
        logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, { error });
        await sleep(delay);
      }
    }
  }

  static handleOrderError(error, context) {
    if (error.code === 'INSUFFICIENT_BALANCE') {
      // 暂停交易，发送告警
      stateMachine.transition('PAUSE');
      alerter.send('CRITICAL', 'Insufficient balance', context);
    } else if (error.code === 'RATE_LIMITED') {
      // 等待后重试
      return ErrorHandler.withRetry(() => context.retry(), 3, 5000);
    } else {
      // 记录未知错误
      logger.error('Unknown order error', { error, context });
    }
  }
}
```

---

## 8. 部署架构

### 8.1 开发环境

```
┌─────────────────────────────────────┐
│          Development Machine         │
│                                      │
│  ┌────────────┐   ┌────────────┐    │
│  │  Bot App   │   │  SQLite    │    │
│  │  (Node.js) │   │   (local)  │    │
│  └─────┬──────┘   └────────────┘    │
│        │                             │
│        ▼                             │
│  ┌────────────┐                      │
│  │  Testnet   │                      │
│  │   Wallet   │                      │
│  └────────────┘                      │
└─────────────────────────────────────┘
```

### 8.2 生产环境

```
┌─────────────────────────────────────────────────────────────┐
│                    Production Infrastructure                 │
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │ Raspberry   │    │   VPS       │    │  Dedicated  │      │
│  │    Pi 4     │ or │ (Low Lat.)  │ or │   Server    │      │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘      │
│         │                  │                  │              │
│         └────────────┬─────┴──────────────────┘              │
│                      │                                       │
│  ┌───────────────────┼───────────────────────────────────┐  │
│  │                   ▼                                    │  │
│  │  ┌────────────────────────────────────────────────┐   │  │
│  │  │                Bot Application                  │   │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐      │   │  │
│  │  │  │ Watcher  │  │ Executor │  │  Logger  │      │   │  │
│  │  │  └──────────┘  └──────────┘  └──────────┘      │   │  │
│  │  └────────────────────────────────────────────────┘   │  │
│  │                                                        │  │
│  │  ┌──────────────┐    ┌──────────────┐                 │  │
│  │  │   SQLite     │    │   Secrets    │                 │  │
│  │  │  (Encrypted) │    │   Manager    │                 │  │
│  │  └──────────────┘    └──────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Monitoring Stack                      │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │ │
│  │  │ Telegram │  │ Grafana  │  │  Sentry  │              │ │
│  │  │   Bot    │  │ (Metrics)│  │ (Errors) │              │ │
│  │  └──────────┘  └──────────┘  └──────────┘              │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 8.3 延迟优化策略

| 优化项 | 方案 | 预期改善 |
|--------|------|----------|
| 语言选择 | Rust替代Node.js | 50-70% 处理时间减少 |
| RPC节点 | 自建Polygon节点 | 30-50ms 延迟减少 |
| 服务器位置 | 靠近Polymarket服务器 | 50-100ms 网络延迟减少 |
| 连接复用 | 保持长连接 | 避免握手开销 |
| 数据结构 | 使用无锁数据结构 | 减少并发争用 |

---

## 9. 安全考虑

### 9.1 密钥管理

- 私钥使用环境变量或加密密钥库存储
- 禁止私钥出现在代码或日志中
- 支持硬件钱包签名 (未来)

### 9.2 访问控制

```javascript
// 示例: 加密配置
const crypto = require('crypto');

class SecureConfig {
  static encrypt(plaintext, password) {
    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
  }

  static decrypt(encrypted, password) {
    const key = crypto.scryptSync(password, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
    return decipher.update(encrypted.data, 'hex', 'utf8') + decipher.final('utf8');
  }
}
```

---

## 10. 测试策略

### 10.1 测试金字塔

```
                    ┌────────┐
                    │  E2E   │  (真实市场模拟)
                   ┌┴────────┴┐
                   │Integration│ (模块集成)
                  ┌┴──────────┴┐
                  │    Unit     │ (单元测试)
                 └──────────────┘
```

### 10.2 测试覆盖

| 模块 | 测试类型 | 覆盖目标 |
|------|----------|----------|
| DumpDetector | 单元测试 | 100% |
| HedgeStrategy | 单元测试 | 100% |
| StateMachine | 单元测试 | 100% |
| OrderExecutor | 集成测试 | 80% |
| 完整流程 | E2E测试 | 核心路径 |

---

## 附录A: API参考

### Polymarket CLOB API

**WebSocket 订阅**:
```
wss://clob.polymarket.com/ws/market
```

**REST Endpoints**:
- `GET /markets` - 获取市场列表
- `GET /orderbook/{token_id}` - 获取订单簿
- `POST /order` - 提交订单
- `DELETE /order/{order_id}` - 取消订单

---

## 附录B: 配置示例

```json
{
  "trading": {
    "shares": 20,
    "sumTarget": 0.95,
    "movePct": 0.15,
    "windowMin": 2
  },
  "network": {
    "wsUrl": "wss://clob.polymarket.com/ws/market",
    "apiUrl": "https://clob.polymarket.com",
    "reconnectDelay": 1000,
    "maxReconnects": 5
  },
  "fees": {
    "feeRate": 0.005,
    "spreadBuffer": 0.02
  },
  "logging": {
    "level": "info",
    "file": "./logs/bot.log"
  }
}
```
