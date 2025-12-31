# 部署指南

本文档介绍如何部署 Polymarket Dump & Hedge Bot。

## 目录

1. [环境要求](#环境要求)
2. [快速开始](#快速开始)
3. [配置说明](#配置说明)
4. [运行模式](#运行模式)
5. [生产部署](#生产部署)
6. [监控与告警](#监控与告警)
7. [故障排除](#故障排除)

---

## 环境要求

### 系统要求

- **Node.js**: >= 20.0.0 (推荐 LTS 版本)
- **npm**: >= 10.0.0
- **操作系统**: Linux (推荐), macOS, Windows
- **内存**: >= 512MB
- **存储**: >= 100MB (不含日志)

### 网络要求

- 稳定的互联网连接
- 能够访问以下端点:
  - `https://clob.polymarket.com` (REST API)
  - `wss://ws-subscriptions-clob.polymarket.com` (WebSocket)
  - `https://gamma-api.polymarket.com` (可选)
  - `https://data-api.polymarket.com` (可选)

---

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd pmdumphedge
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置文件
nano .env
```

### 4. 构建项目

```bash
npm run build
```

### 5. 运行测试

```bash
# 单元测试
npm test

# 集成测试 (可选)
npm run test:integration

# E2E 测试 (可选)
npm run test:e2e

# 性能测试 (可选)
npm run test:perf

# 所有测试
npm run test:all
```

### 6. 启动 Bot

```bash
# Dry Run 模式 (推荐先测试)
npm run bot -- --dry

# 实盘模式 (需要配置钱包和 Builder API)
npm run bot
```

---

## 配置说明

### 必填配置

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `TOKEN_ID_UP` | UP Token ID | `0x123...` |
| `TOKEN_ID_DOWN` | DOWN Token ID | `0x456...` |

### API 端点配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `API_URL` | CLOB REST API | `https://clob.polymarket.com` |
| `WS_URL` | CLOB WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| `CLOB_API` | CLOB API (备用) | `https://clob.polymarket.com` |
| `GAMMA_API` | Gamma API | `https://gamma-api.polymarket.com` |
| `DATA_API` | Data API | `https://data-api.polymarket.com` |
| `CLOB_WS` | CLOB WebSocket (备用) | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| `RTDS_WS` | RTDS WebSocket | `wss://ws-live-data.polymarket.com` |

### 钱包配置 (实盘必填)

| 环境变量 | 说明 |
|---------|------|
| `PRIVATE_KEY` | 以太坊私钥 (不带 0x) |
| `WALLET_ADDRESS` | 钱包地址 (带 0x) |

### Builder API 配置 (推荐)

| 环境变量 | 说明 |
|---------|------|
| `BUILDER_API_KEY` | Builder API Key |
| `BUILDER_SECRET` | Builder Secret (Base64) |
| `BUILDER_PASSPHRASE` | Builder Passphrase |

获取 Builder 凭据: https://polymarket.com/settings?tab=builder

### 交易参数

| 环境变量 | 说明 | 默认值 | 范围 |
|---------|------|-------|------|
| `DEFAULT_SHARES` | 每笔份数 | 20 | 1-10000 |
| `SUM_TARGET` | 对冲阈值 | 0.95 | 0.5-1.0 |
| `MOVE_PCT` | 暴跌检测阈值 | 0.15 | 0.01-0.50 |
| `WINDOW_MIN` | 监控窗口(分钟) | 2 | 1-15 |
| `FEE_RATE` | 手续费率 | 0.005 | 0-0.10 |
| `SPREAD_BUFFER` | 滑点缓冲 | 0.02 | 0-0.20 |

### 运行模式

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `READ_ONLY` | 只读模式 | false |
| `DRY_RUN` | 模拟模式 | false |

### 告警配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `ALERT_MIN_SEVERITY` | 最低告警级别 | `info` |
| `ALERT_THROTTLE_ENABLED` | 启用告警节流 | `true` |
| `ALERT_THROTTLE_WINDOW_MS` | 节流时间窗口 (ms) | `60000` |
| `ALERT_THROTTLE_MAX_PER_WINDOW` | 窗口内最大告警数 | `10` |

### Telegram 告警配置

| 环境变量 | 说明 |
|---------|------|
| `TELEGRAM_ENABLED` | 启用 Telegram 告警 |
| `TELEGRAM_BOT_TOKEN` | Bot Token (从 @BotFather 获取) |
| `TELEGRAM_CHAT_ID` | 聊天 ID |

### Discord 告警配置

| 环境变量 | 说明 |
|---------|------|
| `DISCORD_ENABLED` | 启用 Discord 告警 |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL |

### 静默时段配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `ALERT_QUIET_HOURS_ENABLED` | 启用静默时段 | `false` |
| `ALERT_QUIET_HOURS_START` | 开始时间 (24小时制) | `22` |
| `ALERT_QUIET_HOURS_END` | 结束时间 | `8` |
| `ALERT_QUIET_HOURS_TIMEZONE` | 时区 | `Asia/Shanghai` |

---

## 运行模式

### Dry Run 模式 (推荐开始)

模拟交易，不使用真实资金:

```bash
npm run bot -- --dry
```

特点:
- 连接真实 WebSocket 获取价格
- 模拟订单执行
- 生成模拟交易日志
- 适合测试策略参数

### Read-Only 模式

仅监控价格，不执行任何交易:

```bash
READ_ONLY=true npm run bot
```

特点:
- 只显示价格和信号
- 不提交任何订单
- 适合观察市场

### 实盘模式

执行真实交易:

```bash
npm run bot
```

要求:
- 配置 `PRIVATE_KEY` 和 `WALLET_ADDRESS`
- 钱包有足够的 USDC 余额
- 推荐配置 Builder API 获得订单归因

### Dashboard 模式

交互式终端界面:

```bash
# Dry Run
npm run dashboard -- --dry

# 实盘
npm run dashboard
```

Dashboard 快捷键:
| 按键 | 功能 |
|------|------|
| `q` | 退出 |
| `s` | 启动/停止引擎 |
| `u` | 手动买入 UP |
| `d` | 手动买入 DOWN |
| `p` | 调整参数 |
| `r` | 刷新 |
| `c` | 清空日志 |

---

## 生产部署

### 使用 PM2 (推荐)

```bash
# 安装 PM2
npm install -g pm2

# 启动 Bot
pm2 start npm --name "pm-bot" -- run bot

# 查看状态
pm2 status

# 查看日志
pm2 logs pm-bot

# 停止
pm2 stop pm-bot

# 重启
pm2 restart pm-bot

# 开机自启
pm2 startup
pm2 save
```

### PM2 配置文件

创建 `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'pm-bot',
    script: 'npm',
    args: 'run bot',
    cwd: '/path/to/pmdumphedge',
    env: {
      NODE_ENV: 'production',
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    time: true,
  }]
};
```

### 使用 Docker

创建 `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist
COPY .env .env

CMD ["node", "dist/index.js"]
```

构建和运行:

```bash
# 构建
npm run build
docker build -t pm-bot .

# 运行
docker run -d --name pm-bot --restart unless-stopped pm-bot
```

### Docker Compose

创建 `docker-compose.yml`:

```yaml
version: '3.8'
services:
  pm-bot:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
```

运行:

```bash
docker-compose up -d
```

### 使用 systemd

创建 `/etc/systemd/system/pm-bot.service`:

```ini
[Unit]
Description=Polymarket Dump & Hedge Bot
After=network.target

[Service]
Type=simple
User=bot
WorkingDirectory=/path/to/pmdumphedge
ExecStart=/usr/bin/node /path/to/pmdumphedge/dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/pm-bot/output.log
StandardError=append:/var/log/pm-bot/error.log

[Install]
WantedBy=multi-user.target
```

启动服务:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pm-bot
sudo systemctl start pm-bot
sudo systemctl status pm-bot
```

---

## 监控与告警

### 日志监控

日志位置: `./logs/bot.log`

日志级别:
- `debug`: 详细调试信息
- `info`: 正常运行信息
- `warn`: 警告信息
- `error`: 错误信息

设置日志级别:
```bash
LOG_LEVEL=debug npm run bot
```

### 告警渠道配置

#### Telegram 告警

1. 创建 Telegram Bot:
   - 与 @BotFather 对话
   - 发送 `/newbot` 创建机器人
   - 保存 Bot Token

2. 获取 Chat ID:
   - 发送消息给你的 Bot
   - 访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - 找到 `chat.id`

3. 配置环境变量:
   ```bash
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```

#### Discord 告警

1. 创建 Discord Webhook:
   - 服务器设置 → 整合 → Webhook
   - 创建新 Webhook
   - 复制 Webhook URL

2. 配置环境变量:
   ```bash
   DISCORD_ENABLED=true
   DISCORD_WEBHOOK_URL=your_webhook_url
   ```

### 告警类型

| 类型 | 级别 | 说明 |
|------|------|------|
| `dump_detected` | warning | 暴跌信号检测 |
| `trade_completed` | info | 交易周期完成 |
| `order_failed` | critical | 订单执行失败 |
| `ws_disconnected` | warning | WebSocket 断开 |
| `insufficient_funds` | critical | 余额不足 |
| `round_expired_loss` | warning | 回合过期亏损 |
| `system_error` | critical | 系统错误 |

### 健康检查端点

Bot 会定期输出心跳日志，可以用于监控:

```bash
grep "heartbeat" ./logs/bot.log | tail -1
```

### 性能监控

运行性能测试:

```bash
npm run test:perf
```

关键性能指标:
- 价格处理周期: < 5ms
- 对冲判断: < 0.001ms
- 概率预测: < 1ms

---

## 故障排除

### 常见问题

#### 1. WebSocket 连接失败

症状:
```
WebSocket connection failed
```

解决方案:
- 检查网络连接
- 确认 `WS_URL` 正确
- 检查防火墙设置

#### 2. 认证失败

症状:
```
API error: Unauthorized
```

解决方案:
- 确认 `BUILDER_API_KEY`, `BUILDER_SECRET`, `BUILDER_PASSPHRASE` 正确
- 检查 Builder 凭据是否过期
- 确认系统时间同步

#### 3. 余额不足

症状:
```
Insufficient balance
```

解决方案:
- 确保钱包有足够的 USDC
- 检查 `DEFAULT_SHARES` 设置
- 在 Polymarket 上添加资金

#### 4. 订单被拒绝

症状:
```
Order rejected
```

解决方案:
- 检查价格是否在合理范围
- 确认 Token ID 正确
- 查看 API 返回的错误详情

#### 5. 告警发送失败

症状:
```
Failed to send Telegram alert
```

解决方案:
- 确认 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 正确
- 检查 Bot 是否已启动并添加到聊天
- 确认网络能访问 Telegram API

### 调试模式

启用详细日志:

```bash
LOG_LEVEL=debug DRY_RUN=true npm run bot
```

### 重置状态

如果需要重新开始:

```bash
# 备份数据
cp ./data/bot.db ./data/bot.db.backup

# 删除数据库 (可选)
rm ./data/bot.db

# 清理日志 (可选)
rm ./logs/*.log

# 重新启动
npm run bot -- --dry
```

---

## 安全建议

1. **私钥保护**
   - 永远不要提交私钥到版本控制
   - 使用专用交易钱包，不要使用主钱包
   - 定期轮换 Builder API 凭据

2. **服务器安全**
   - 使用防火墙限制入站连接
   - 启用 SSH 密钥认证
   - 定期更新系统和依赖

3. **监控**
   - 设置资金变动告警
   - 监控异常交易行为
   - 定期审计日志
   - 配置 Telegram/Discord 告警接收实时通知

---

## 支持

如有问题，请:
1. 查看本文档的故障排除部分
2. 检查项目 Issues
3. 提交新 Issue 并附上详细日志
