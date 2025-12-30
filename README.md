# Polymarket Dump & Hedge Bot

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

- **实时监控**: WebSocket 连接 Polymarket CLOB API，毫秒级价格更新
- **智能检测**: 滑动窗口算法检测暴跌信号，可配置阈值和时间窗口
- **自动对冲**: 满足条件自动执行对冲，锁定无风险利润
- **回测系统**: 历史数据回放，参数网格优化
- **终端界面**: blessed 打造的交互式 Dashboard
- **数据持久化**: SQLite 存储行情数据和交易记录
- **Dry-Run 模式**: 模拟交易，安全测试策略

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

# 交易配置
PRIVATE_KEY=<你的私钥>  # 仅实盘需要
MOVE_PCT=0.15           # 暴跌阈值 (15%)
WINDOW_MIN=10           # 监控窗口 (分钟)
SUM_TARGET=0.95         # 对冲目标价格
SHARES=100              # 每笔交易份额
FEE_RATE=0.002          # 手续费率 (0.2%)

# 模式
DRY_RUN=true            # Dry-Run 模式

# 数据库
DB_PATH=./data/bot.db
```

### 运行

```bash
# 开发模式 (Dry-Run)
npm run bot:dry

# 实盘模式 (谨慎使用)
npm run bot

# 交互式 Dashboard
npm run dashboard:dry
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
│   ├── core/                 # 核心模块
│   │   ├── StateMachine.ts   # 交易状态机
│   │   ├── DumpDetector.ts   # 暴跌检测器
│   │   ├── HedgeStrategy.ts  # 对冲策略
│   │   ├── OrderExecutor.ts  # 订单执行器
│   │   └── TradingEngine.ts  # 交易引擎
│   ├── ws/                   # WebSocket 客户端
│   │   └── WebSocketClient.ts
│   ├── db/                   # 数据库层
│   │   ├── Database.ts       # SQLite 封装
│   │   └── schema.sql        # 数据库 Schema
│   ├── backtest/             # 回测模块
│   │   ├── BacktestEngine.ts # 回测引擎
│   │   └── ReplayEngine.ts   # 数据回放
│   ├── ui/                   # 终端 UI
│   │   └── Dashboard.ts      # blessed Dashboard
│   ├── utils/                # 工具类
│   │   ├── CircularBuffer.ts # 环形缓冲区
│   │   ├── config.ts         # 配置加载
│   │   ├── logger.ts         # 日志系统
│   │   └── eventBus.ts       # 事件总线
│   ├── types/                # TypeScript 类型定义
│   │   └── index.ts
│   ├── index.ts              # 主入口
│   ├── recorder.ts           # 数据录制入口
│   ├── backtest.ts           # 回测 CLI 入口
│   └── dashboard.ts          # Dashboard 入口
├── tests/                    # 单元测试
│   ├── CircularBuffer.test.ts
│   ├── StateMachine.test.ts
│   ├── DumpDetector.test.ts
│   └── HedgeStrategy.test.ts
├── data/                     # 数据目录
├── logs/                     # 日志目录
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## API 参考

### 核心类

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

对冲策略计算器。

```typescript
const strategy = new HedgeStrategy(config);

// 检查是否应该对冲
strategy.shouldHedge(leg1Price, oppositeAsk);

// 计算对冲详情
const calc = strategy.calculateHedge(leg1Info, currentPrice);
if (calc.shouldHedge) {
  console.log(`净利润: $${calc.potentialProfit}`);
}

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
| `m` | 手动买入 (测试用) |
| `r` | 刷新界面 |
| `c` | 清空日志 |

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

## 测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage

# 类型检查
npm run typecheck
```

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

## 许可证

MIT License

## 作者

Kyd
