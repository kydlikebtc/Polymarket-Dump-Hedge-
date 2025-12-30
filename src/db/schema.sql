-- Polymarket Dump & Hedge 数据库 Schema
-- 数据库: SQLite 3

-- ===== 价格快照表 =====
-- 存储实时价格数据，用于回测
CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,                    -- Unix毫秒时间戳
    round_slug TEXT NOT NULL,                      -- 轮次标识
    seconds_remaining INTEGER,                     -- 轮次剩余秒数
    up_token_id TEXT NOT NULL,                     -- UP Token ID
    down_token_id TEXT NOT NULL,                   -- DOWN Token ID
    up_best_ask REAL NOT NULL,                     -- UP最优卖价
    up_best_bid REAL,                              -- UP最优买价
    down_best_ask REAL NOT NULL,                   -- DOWN最优卖价
    down_best_bid REAL,                            -- DOWN最优买价
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON price_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_snapshots_round ON price_snapshots(round_slug);
CREATE INDEX IF NOT EXISTS idx_snapshots_round_time ON price_snapshots(round_slug, timestamp);

-- ===== 交易周期表 =====
-- 存储每个交易周期的完整信息
CREATE TABLE IF NOT EXISTS trade_cycles (
    id TEXT PRIMARY KEY,                           -- 周期唯一ID
    round_slug TEXT NOT NULL,                      -- 所属轮次
    status TEXT NOT NULL,                          -- 状态: IDLE, WATCHING, LEG1_FILLED, COMPLETED, EXPIRED, ERROR

    -- Leg 1 信息
    leg1_order_id TEXT,
    leg1_side TEXT,                                -- UP or DOWN
    leg1_shares REAL,
    leg1_price REAL,
    leg1_cost REAL,
    leg1_filled_at INTEGER,

    -- Leg 2 信息
    leg2_order_id TEXT,
    leg2_side TEXT,
    leg2_shares REAL,
    leg2_price REAL,
    leg2_cost REAL,
    leg2_filled_at INTEGER,

    -- 收益信息
    profit REAL,
    guaranteed_profit REAL,

    -- 元数据
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cycles_round ON trade_cycles(round_slug);
CREATE INDEX IF NOT EXISTS idx_cycles_status ON trade_cycles(status);
CREATE INDEX IF NOT EXISTS idx_cycles_created ON trade_cycles(created_at);

-- ===== 订单历史表 =====
-- 存储所有订单记录
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,                           -- 订单ID
    cycle_id TEXT,                                 -- 关联的交易周期
    side TEXT NOT NULL,                            -- UP or DOWN
    order_type TEXT NOT NULL,                      -- MARKET, LIMIT
    shares REAL NOT NULL,
    price REAL,                                    -- Limit Order 价格
    avg_fill_price REAL,                           -- 平均成交价
    total_cost REAL,                               -- 总成本
    status TEXT NOT NULL,                          -- PENDING, FILLED, PARTIAL, CANCELLED, REJECTED
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    filled_at DATETIME,
    FOREIGN KEY (cycle_id) REFERENCES trade_cycles(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_cycle ON orders(cycle_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- ===== 配置快照表 =====
-- 存储配置历史，用于回测对比
CREATE TABLE IF NOT EXISTS config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shares REAL,
    sum_target REAL,
    move_pct REAL,
    window_min INTEGER,
    fee_rate REAL,
    spread_buffer REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===== 回测结果表 =====
-- 存储回测运行结果
CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_snapshot_id INTEGER,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    initial_capital REAL NOT NULL,

    -- 统计数据
    total_trades INTEGER,
    winning_trades INTEGER,
    losing_trades INTEGER,
    win_rate REAL,
    total_profit REAL,
    total_loss REAL,
    net_profit REAL,
    max_drawdown REAL,
    max_drawdown_pct REAL,
    sharpe_ratio REAL,
    profit_factor REAL,
    final_equity REAL,
    return_pct REAL,

    -- 元数据
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (config_snapshot_id) REFERENCES config_snapshots(id)
);

-- ===== 轮次信息表 =====
-- 缓存轮次信息
CREATE TABLE IF NOT EXISTS rounds (
    slug TEXT PRIMARY KEY,
    up_token_id TEXT NOT NULL,
    down_token_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    status TEXT NOT NULL,                          -- active, resolved, pending
    resolution TEXT,                               -- UP, DOWN, null
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rounds_time ON rounds(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);

-- ===== 告警历史表 =====
-- 存储系统告警
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT NOT NULL,                        -- info, warning, critical
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,                                     -- JSON 格式的额外数据
    acknowledged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

-- ===== 系统状态表 =====
-- 存储系统运行状态
CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 初始化系统状态
INSERT OR IGNORE INTO system_state (key, value) VALUES ('last_startup', datetime('now'));
INSERT OR IGNORE INTO system_state (key, value) VALUES ('schema_version', '1.0.0');
