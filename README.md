# Polymarket Dump & Hedge Bot

[![Tests](https://img.shields.io/badge/tests-323%20passed-brightgreen)](./tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

全自动化 Polymarket 预测市场套利机器人 - 暴跌接针 + 无风险对冲策略

## 策略原理

### Dump & Hedge 策略

本机器人针对 Polymarket 的 BTC 15分钟 UP/DOWN 预测市场，执行"暴跌接针 + 对冲锁利"策略：

1. **暴跌检测 (Dump Detection)**
   - 监控 UP 和 DOWN 代币价格
   - 当某一侧在 3 秒内暴跌超过 15% 时触发信号
   - 暴跌通常由恐慌性抛售造成，价格被低估

2. **Leg 1: 接针买入**
   - 检测到暴跌后，立即买入被抛售的代币
   - 例如：UP 从 $0.60 暴跌到 $0.45，买入 UP

3. **Leg 2: 对冲锁利**
   - 等待 UP + DOWN 总价 ≤ 0.95 (sumTarget)
   - 买入对手方代币完成对冲
   - 例如：UP=$0.45, DOWN=$0.50, 总价=0.95

4. **无风险收益**
   - 结算时必定有一方价值 $1.00
   - 成本 = UP价格 + DOWN价格 = $0.95
   - 毛利润 = $1.00 - $0.95 = $0.05 (5%)

### 状态机流程

```
IDLE → WATCHING → LEG1_PENDING → LEG1_FILLED → LEG2_PENDING → COMPLETED
  ↑                    ↓              ↓              ↓
  └──────────────── ERROR ←──────────────────────────┘
                       ↓
                 ROUND_EXPIRED
```

## 功能特性

### 核心功能
- **实时监控**: WebSocket 连接 Polymarket CLOB API，毫秒级价格更新
- **智能检测**: 滑动窗口算法检测暴跌信号，可配置阈值和时间窗口
- **自动对冲**: 满足条件自动执行对冲，锁定无风险利润
- **对冲概率预测**: 多因子分析预测对冲成功概率和时间
- **回测系统**: 历史数据回放，参数网格优化
- **终端界面**: blessed 打造的交互式 Dashboard
- **数据持久化**: SQLite 存储行情数据和交易记录
- **Dry-Run 模式**: 模拟交易，安全测试策略

### v0.2.0 新功能
- **市场自动发现**: 自动发现并切换到最新的 BTC 15 分钟预测市场
- **轮次自动轮换**: 当前轮次到期后无缝切换到下一轮，无需手动更新 Token ID
- **专业交易面板**: 全新 TradingDashboard，包含持仓、市场分析、订单簿、交易流水
- **订单簿深度**: MarketWatcher 支持完整订单簿数据和深度分析

### v0.3.0 预览功能 (开发中)
- **MARKET INFO 区域**: 显示当前市场、剩余时间倒计时、Token ID
- **ORDER BOOK 区域**: 实时订单簿深度显示，UP/DOWN 分栏，最多 10 档
- **MARKET ANALYSIS 增强**: 可视化套利进度条、Delta 差值、累计盈亏统计
- **静态市场 Fallback**: 当自动发现未找到市场时使用 .env 中的静态 Token ID

### 告警系统
- **多渠道告警**: 支持 Console、Telegram Bot、Discord Webhook
- **智能节流**: 可配置时间窗口内的最大告警数量
- **静默时段**: 支持配置免打扰时间段
- **分级告警**: info / warning / critical 三级告警
- **实时通知**: 暴跌检测、订单状态、系统错误等关键事件

### Builder API 支持
- **订单归属**: 支持 Builder API 实现订单归属追踪
- **HMAC 签名**: 完整的请求签名认证机制

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- pnpm / npm / yarn

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd pmdumphedge

# 安装依赖
npm install

# 复制配置文件
cp .env.example .env
```

### 配置

编辑 `.env` 文件：

```env
# Polymarket 配置
TOKEN_ID_UP=<UP代币ID>
TOKEN_ID_DOWN=<DOWN代币ID>
CONDITION_ID=<条件ID>

# API 配置
WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
API_URL=https://clob.polymarket.com
CLOB_API=https://clob.polymarket.com
GAMMA_API=https://gamma-api.polymarket.com
DATA_API=https://data-api.polymarket.com
CLOB_WS=wss://ws-subscriptions-clob.polymarket.com/ws/market
RTDS_WS=wss://ws-live-data.polymarket.com

# 交易配置
PRIVATE_KEY=<你的私钥>  # 仅实盘需要
MOVE_PCT=0.15           # 暴跌阈值 (15%)
WINDOW_MIN=2            # 监控窗口 (分钟)
SUM_TARGET=0.95         # 对冲目标价格
DEFAULT_SHARES=20       # 每笔交易份额
FEE_RATE=0.005          # 手续费率 (0.5%)

# Builder API (可选，用于订单归属)
BUILDER_API_KEY=<Builder API Key>
BUILDER_SECRET=<Builder Secret>
BUILDER_PASSPHRASE=<Builder Passphrase>

# 模式
DRY_RUN=true            # Dry-Run 模式
READ_ONLY=false         # 只读模式

# v0.2.0: 市场自动发现
AUTO_DISCOVER_MARKET=true           # 启用自动发现
MARKET_DISCOVERY_INTERVAL=10000     # 发现间隔 (ms)

# 数据库
DB_PATH=./data/bot.db

# 告警配置
ALERT_MIN_SEVERITY=info              # 最低告警级别 (info/warning/critical)
ALERT_THROTTLE_ENABLED=true          # 启用告警节流
ALERT_THROTTLE_WINDOW_MS=60000       # 节流时间窗口 (ms)
ALERT_THROTTLE_MAX_PER_WINDOW=10     # 窗口内最大告警数

# Telegram 告警
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=<Bot Token>
TELEGRAM_CHAT_ID=<Chat ID>

# Discord 告警
DISCORD_ENABLED=false
DISCORD_WEBHOOK_URL=<Webhook URL>

# 静默时段
ALERT_QUIET_HOURS_ENABLED=false
ALERT_QUIET_HOURS_START=22           # 开始时间 (24小时制)
ALERT_QUIET_HOURS_END=8              # 结束时间
ALERT_QUIET_HOURS_TIMEZONE=Asia/Shanghai
```

### 运行

```bash
# 开发模式 (Dry-Run)
npm run bot -- --dry

# 实盘模式 (谨慎使用)
npm run bot

# 交互式 Dashboard (Dry-Run)
npm run dashboard -- --dry

# 交互式 Dashboard (实盘)
npm run dashboard

# 数据录制 (用于回测)
npm run recorder

# 回测
npm run backtest -- --start 2024-01-01 --end 2024-01-31

# 参数优化
npm run backtest -- --optimize \
  --param movePct:10,15,20 \
  --param sumTarget:0.93,0.95,0.97
```

## 项目结构

```
pmdumphedge/
├── src/
│   ├── core/                   # 核心模块
│   │   ├── StateMachine.ts     # 交易状态机
│   │   ├── DumpDetector.ts     # 暴跌检测器
│   │   ├── HedgeStrategy.ts    # 对冲策略 (含概率预测)
│   │   ├── OrderExecutor.ts    # 订单执行器
│   │   ├── RoundManager.ts     # 轮次管理器 (含自动轮换)
│   │   └── TradingEngine.ts    # 交易引擎 (含告警集成)
│   ├── api/                    # API 客户端
│   │   ├── PolymarketClient.ts # Polymarket API (含 Builder API)
│   │   └── MarketWatcher.ts    # 市场监控器 (含订单簿)
│   ├── services/               # 服务层
│   │   └── MarketDiscoveryService.ts  # BTC 15m 市场发现服务
│   ├── ws/                     # WebSocket 客户端
│   │   └── WebSocketClient.ts
│   ├── db/                     # 数据库层
│   │   ├── Database.ts         # SQLite 封装
│   │   └── schema.sql          # 数据库 Schema
│   ├── backtest/               # 回测模块
│   │   ├── BacktestEngine.ts   # 回测引擎
│   │   └── ReplayEngine.ts     # 数据回放
│   ├── ui/                     # 终端 UI
│   │   ├── Dashboard.ts        # blessed Dashboard (含告警面板)
│   │   └── TradingDashboard.ts # 专业交易面板 (v0.2.0)
│   ├── utils/                  # 工具类
│   │   ├── AlertManager.ts     # 告警管理器
│   │   ├── CircularBuffer.ts   # 环形缓冲区
│   │   ├── config.ts           # 配置加载 (含告警配置)
│   │   ├── logger.ts           # 日志系统
│   │   └── EventBus.ts         # 事件总线
│   ├── types/                  # TypeScript 类型定义
│   │   └── index.ts
│   ├── index.ts                # Bot 主入口
│   ├── recorder.ts             # 数据录制入口
│   ├── backtest.ts             # 回测 CLI 入口
│   └── dashboard.ts            # Dashboard 入口
├── tests/                      # 测试套件
│   ├── integration/            # 集成测试
│   ├── e2e/                    # 端到端测试
│   ├── performance/            # 性能测试
│   ├── AlertManager.test.ts
│   ├── BacktestEngine.test.ts
│   ├── CircularBuffer.test.ts
│   ├── DumpDetector.test.ts
│   ├── HedgeStrategy.test.ts
│   ├── MarketDiscoveryService.test.ts  # v0.2.0
│   ├── MarketWatcher.test.ts
│   ├── PolymarketClient.test.ts
│   ├── RoundManager.test.ts            # v0.2.0 (含自动轮换)
│   ├── StateMachine.test.ts
│   ├── TradingEngine.test.ts
│   └── config.test.ts
├── docs/                       # 文档
│   └── DEPLOYMENT.md           # 部署指南
├── data/                       # 数据目录
├── logs/                       # 日志目录
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CHANGELOG.md                # 更新日志
└── README.md
```

## API 参考

### 核心类

#### TradingEngine

交易引擎，协调所有核心组件。

```typescript
import { TradingEngine } from './core/TradingEngine.js';
import { loadConfig } from './utils/config.js';

const config = loadConfig();
const engine = new TradingEngine(config);

// 启动/停止
await engine.start();
await engine.stop();

// 查询状态
engine.isEngineRunning();           // boolean
engine.getStateMachine();           // StateMachine
engine.getMarketWatcher();          // MarketWatcher
engine.getRoundManager();           // RoundManager
```

#### AlertManager

告警管理器，支持多渠道通知。

```typescript
import { getAlertManager, initAlertManager } from './utils/AlertManager.js';

// 初始化 (通常在启动时调用)
initAlertManager({
  channels: {
    console: true,
    telegram: { botToken: '...', chatId: '...', enabled: true },
    discord: { webhookUrl: '...', enabled: false },
  },
  minSeverity: 'info',
  throttle: { enabled: true, windowMs: 60000, maxPerWindow: 10 },
});

// 发送告警
const alertManager = getAlertManager();
await alertManager.send({
  type: 'dump_detected',
  severity: 'warning',
  title: '暴跌检测',
  message: 'UP 价格暴跌 15%',
  data: { side: 'UP', dropPct: 0.15 },
});

// 使用预定义模板
await alertManager.alertDumpDetected('UP', 0.60, 0.45, 0.25);
await alertManager.alertTradeCompleted(tradeCycle, profit);
await alertManager.alertOrderFailed('Leg1', 'Insufficient funds');
```

#### StateMachine

交易状态机，管理完整的交易周期。

```typescript
const fsm = new StateMachine();

// 开始新周期
fsm.startNewCycle('BTC-15min-2024-01-01');

// 状态转换
fsm.transition('LEG1_PENDING', 'dump_detected');
fsm.transition('LEG1_FILLED', 'order_filled');

// 查询状态
fsm.getCurrentStatus();  // { state, cycleId, ... }
fsm.isActive();          // boolean
fsm.isWaitingForHedge(); // boolean
```

#### DumpDetector

暴跌检测器，分析价格序列检测暴跌信号。

```typescript
const detector = new DumpDetector(config);

// 设置回合开始时间
detector.setRoundStartTime(Date.now());

// 检测暴跌
const signal = detector.detect(priceBuffer, 'round-id');
if (signal) {
  console.log(`${signal.side} 暴跌! 跌幅: ${signal.dropPct}%`);
}

// 锁定方向 (防止重复触发)
detector.lockSide('UP');
```

#### HedgeStrategy

对冲策略计算器，含概率预测功能。

```typescript
const strategy = new HedgeStrategy(config);

// 检查是否应该对冲
strategy.shouldHedge(leg1Price, oppositeAsk);

// 计算对冲详情
const calc = strategy.calculateHedge(leg1Info, currentPrice);
if (calc.shouldHedge) {
  console.log(`净利润: $${calc.potentialProfit}`);
}

// 预测对冲概率
const prediction = strategy.predictHedgeProbability(priceHistory, leg1Info, currentPrice);
console.log(`对冲概率: ${prediction.probability}%`);
console.log(`预计时间: ${prediction.estimatedTime}秒`);
console.log(`建议: ${prediction.recommendation}`);

// 模拟对冲
const sim = strategy.simulateHedge('UP', 0.45, 0.50, 100);
```

#### CircularBuffer

高性能环形缓冲区，用于滑动窗口分析。

```typescript
const buffer = new CircularBuffer<number>(1000);

buffer.push(1);
buffer.push(2);

buffer.size;       // 2
buffer.peek();     // 1 (最旧)
buffer.peekLast(); // 2 (最新)

// 获取时间窗口内的数据
const recent = buffer.getInTimeWindow(3000, item => item.timestamp);
```

## Dashboard 快捷键

| 快捷键 | 功能 |
|--------|------|
| `q` / `Ctrl+C` | 退出 |
| `s` | 启动/停止交易引擎 |
| `u` | 手动买入 UP |
| `d` | 手动买入 DOWN |
| `p` | 调整运行时参数 |
| `r` | 刷新界面 |
| `c` | 清空日志 |

### Dashboard 面板说明

- **HEADER**: 标题栏，显示版本和监控状态
- **MARKET INFO**: 市场信息区域
  - 当前市场名称和剩余时间倒计时
  - UP/DOWN Token ID (缩略显示)
  - 时间颜色指示 (红 < 1分钟, 黄 < 3分钟, 绿)
- **ORDER BOOK**: 实时订单簿
  - UP/DOWN 分栏显示
  - BIDS (买单) 和 ASKS (卖单) 列表
  - 显示最多 10 档深度和总量统计
- **POSITIONS**: 持仓面板
  - UP/DOWN 持仓数量和价格
  - 总盈亏 (Total PnL)
  - 交易量统计
- **MARKET ANALYSIS**: 套利分析面板
  - UP/DOWN 价格百分比
  - Combined 组合价格 + Target 目标阈值
  - Spread 价差百分比
  - 可视化进度条 (`████` 套利机会 / `░░░░` 等待中)
  - Bid 价格对比、Delta 差值
  - 交易周期数 (Pairs) 和累计盈亏 (PnL)
  - 套利机会提示: `🎯 ARBITRAGE OPPORTUNITY!`
- **RECENT TRANSACTIONS**: 最近交易记录
- **STATUS**: 引擎状态、配置参数显示

## 测试

```bash
# 运行所有单元测试
npm test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage

# 集成测试
npm run test:integration

# 端到端测试
npm run test:e2e

# 性能测试
npm run test:perf

# 运行所有测试
npm run test:all

# 类型检查
npm run typecheck
```

### 测试覆盖率

当前测试套件包含 **323 个测试用例**，覆盖率约 **75%**。

主要测试模块：
- 核心模块：StateMachine, DumpDetector, HedgeStrategy, TradingEngine, RoundManager
- API 客户端：PolymarketClient (含 Builder API)
- 服务层：MarketDiscoveryService (市场发现)
- 工具类：CircularBuffer, AlertManager, config
- 回测引擎：BacktestEngine
- 市场监控：MarketWatcher (含订单簿)

## 回测

### 基础回测

```bash
npm run backtest -- --start 2024-01-01 --end 2024-01-31
```

### 参数优化

```bash
npm run backtest -- --optimize \
  --param movePct:10,15,20 \
  --param sumTarget:0.93,0.95,0.97
```

### 导出结果

```bash
# JSON 格式
npm run backtest -- --output results.json --format json

# CSV 格式
npm run backtest -- --output results.csv --format csv
```

### 回测指标

- **总收益率**: 策略总收益百分比
- **夏普比率**: 风险调整后收益
- **最大回撤**: 最大资金回撤比例
- **胜率**: 盈利交易占比
- **盈亏比**: 平均盈利/平均亏损

## 部署

详细部署指南请参考 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)。

快速部署步骤：
1. 配置环境变量
2. 构建项目：`npm run build`
3. 启动服务：`npm run bot` 或 `npm run dashboard`

支持的部署方式：
- PM2 进程管理
- Docker 容器化
- systemd 服务

## 风险提示

1. **市场风险**: 预测市场存在流动性风险和价格操纵风险
2. **技术风险**: 网络延迟、API 故障可能导致订单失败
3. **策略风险**: 回测结果不代表未来收益
4. **资金风险**: 请仅使用可承受损失的资金

**强烈建议**:
- 首先在 Dry-Run 模式下充分测试
- 小资金实盘验证后再逐步加仓
- 持续监控机器人运行状态
- 设置合理的止损机制
- 配置 Telegram/Discord 告警，及时获取通知

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)

## 许可证

MIT License

## 作者

Kyd
