/**
 * 数据库管理模块
 * 使用 better-sqlite3 提供同步、高性能的 SQLite 访问
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import type {
  PriceSnapshot,
  TradeCycle,
  Order,
  CycleStatus,
  BacktestResult,
  BacktestConfig,
} from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DatabaseManager {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.DB_PATH || './data/bot.db';

    // 确保数据目录存在
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    logger.info(`Opening database at ${this.dbPath}`);
    this.db = new Database(this.dbPath);

    // 启用 WAL 模式以提高并发性能
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // 初始化 schema
    this.initSchema();
  }

  /**
   * 初始化数据库 schema
   */
  private initSchema(): void {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
    logger.info('Database schema initialized');
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
    logger.info('Database connection closed');
  }

  // ===== 价格快照操作 =====

  /**
   * 保存价格快照
   */
  savePriceSnapshot(snapshot: PriceSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO price_snapshots (
        timestamp, round_slug, seconds_remaining,
        up_token_id, down_token_id,
        up_best_ask, up_best_bid, down_best_ask, down_best_bid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.timestamp,
      snapshot.roundSlug,
      snapshot.secondsRemaining,
      snapshot.upTokenId,
      snapshot.downTokenId,
      snapshot.upBestAsk,
      snapshot.upBestBid,
      snapshot.downBestAsk,
      snapshot.downBestBid
    );
  }

  /**
   * 批量保存价格快照 (高性能)
   */
  savePriceSnapshotsBatch(snapshots: PriceSnapshot[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO price_snapshots (
        timestamp, round_slug, seconds_remaining,
        up_token_id, down_token_id,
        up_best_ask, up_best_bid, down_best_ask, down_best_bid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((items: PriceSnapshot[]) => {
      for (const snapshot of items) {
        stmt.run(
          snapshot.timestamp,
          snapshot.roundSlug,
          snapshot.secondsRemaining,
          snapshot.upTokenId,
          snapshot.downTokenId,
          snapshot.upBestAsk,
          snapshot.upBestBid,
          snapshot.downBestAsk,
          snapshot.downBestBid
        );
      }
    });

    transaction(snapshots);
    logger.debug(`Saved ${snapshots.length} price snapshots in batch`);
  }

  /**
   * 获取时间范围内的价格快照
   */
  getPriceSnapshots(
    startTime: number,
    endTime: number,
    roundSlug?: string
  ): PriceSnapshot[] {
    let sql = `
      SELECT
        timestamp, round_slug as roundSlug, seconds_remaining as secondsRemaining,
        up_token_id as upTokenId, down_token_id as downTokenId,
        up_best_ask as upBestAsk, up_best_bid as upBestBid,
        down_best_ask as downBestAsk, down_best_bid as downBestBid
      FROM price_snapshots
      WHERE timestamp >= ? AND timestamp <= ?
    `;

    const params: (number | string)[] = [startTime, endTime];

    if (roundSlug) {
      sql += ' AND round_slug = ?';
      params.push(roundSlug);
    }

    sql += ' ORDER BY timestamp ASC';

    return this.db.prepare(sql).all(...params) as PriceSnapshot[];
  }

  /**
   * 获取最新的价格快照
   */
  getLatestPriceSnapshot(): PriceSnapshot | null {
    const row = this.db
      .prepare(
        `
      SELECT
        timestamp, round_slug as roundSlug, seconds_remaining as secondsRemaining,
        up_token_id as upTokenId, down_token_id as downTokenId,
        up_best_ask as upBestAsk, up_best_bid as upBestBid,
        down_best_ask as downBestAsk, down_best_bid as downBestBid
      FROM price_snapshots
      ORDER BY timestamp DESC
      LIMIT 1
    `
      )
      .get();

    return row as PriceSnapshot | null;
  }

  // ===== 交易周期操作 =====

  /**
   * 创建交易周期
   */
  createTradeCycle(cycle: TradeCycle): void {
    const stmt = this.db.prepare(`
      INSERT INTO trade_cycles (
        id, round_slug, status, created_at, updated_at
      ) VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `);

    stmt.run(cycle.id, cycle.roundSlug, cycle.status);
    logger.info(`Created trade cycle: ${cycle.id}`, {
      roundSlug: cycle.roundSlug,
      status: cycle.status,
    });
  }

  /**
   * 更新交易周期
   */
  updateTradeCycle(cycle: TradeCycle): void {
    const stmt = this.db.prepare(`
      UPDATE trade_cycles SET
        status = ?,
        leg1_order_id = ?,
        leg1_side = ?,
        leg1_shares = ?,
        leg1_price = ?,
        leg1_cost = ?,
        leg1_filled_at = ?,
        leg2_order_id = ?,
        leg2_side = ?,
        leg2_shares = ?,
        leg2_price = ?,
        leg2_cost = ?,
        leg2_filled_at = ?,
        profit = ?,
        guaranteed_profit = ?,
        error = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(
      cycle.status,
      cycle.leg1?.orderId,
      cycle.leg1?.side,
      cycle.leg1?.shares,
      cycle.leg1?.entryPrice,
      cycle.leg1?.totalCost,
      cycle.leg1?.filledAt,
      cycle.leg2?.orderId,
      cycle.leg2?.side,
      cycle.leg2?.shares,
      cycle.leg2?.entryPrice,
      cycle.leg2?.totalCost,
      cycle.leg2?.filledAt,
      cycle.profit,
      cycle.guaranteedProfit,
      cycle.error,
      cycle.id
    );

    logger.debug(`Updated trade cycle: ${cycle.id}`, { status: cycle.status });
  }

  /**
   * 获取交易周期
   */
  getTradeCycle(id: string): TradeCycle | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM trade_cycles WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.mapRowToTradeCycle(row);
  }

  /**
   * 获取轮次的所有交易周期
   */
  getTradeCyclesByRound(roundSlug: string): TradeCycle[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM trade_cycles
      WHERE round_slug = ?
      ORDER BY created_at ASC
    `
      )
      .all(roundSlug) as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToTradeCycle(row));
  }

  /**
   * 获取最近的交易周期
   */
  getRecentTradeCycles(limit: number = 20): TradeCycle[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM trade_cycles
      ORDER BY created_at DESC
      LIMIT ?
    `
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToTradeCycle(row));
  }

  /**
   * 获取特定状态的交易周期
   */
  getTradeCyclesByStatus(status: CycleStatus): TradeCycle[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM trade_cycles
      WHERE status = ?
      ORDER BY created_at DESC
    `
      )
      .all(status) as Record<string, unknown>[];

    return rows.map((row) => this.mapRowToTradeCycle(row));
  }

  private mapRowToTradeCycle(row: Record<string, unknown>): TradeCycle {
    const cycle: TradeCycle = {
      id: row.id as string,
      roundSlug: row.round_slug as string,
      status: row.status as CycleStatus,
      createdAt: new Date(row.created_at as string).getTime(),
      updatedAt: new Date(row.updated_at as string).getTime(),
    };

    if (row.leg1_order_id) {
      cycle.leg1 = {
        orderId: row.leg1_order_id as string,
        side: row.leg1_side as 'UP' | 'DOWN',
        shares: row.leg1_shares as number,
        entryPrice: row.leg1_price as number,
        totalCost: row.leg1_cost as number,
        filledAt: row.leg1_filled_at as number,
      };
    }

    if (row.leg2_order_id) {
      cycle.leg2 = {
        orderId: row.leg2_order_id as string,
        side: row.leg2_side as 'UP' | 'DOWN',
        shares: row.leg2_shares as number,
        entryPrice: row.leg2_price as number,
        totalCost: row.leg2_cost as number,
        filledAt: row.leg2_filled_at as number,
      };
    }

    if (row.profit !== null) {
      cycle.profit = row.profit as number;
    }

    if (row.guaranteed_profit !== null) {
      cycle.guaranteedProfit = row.guaranteed_profit as number;
    }

    if (row.error) {
      cycle.error = row.error as string;
    }

    return cycle;
  }

  // ===== 订单操作 =====

  /**
   * 保存订单
   */
  saveOrder(order: Order): void {
    const stmt = this.db.prepare(`
      INSERT INTO orders (
        id, cycle_id, side, order_type, shares, price,
        avg_fill_price, total_cost, status, error, filled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      order.id,
      order.cycleId,
      order.side,
      order.orderType,
      order.shares,
      order.price,
      order.avgFillPrice,
      order.totalCost,
      order.status,
      order.error,
      order.filledAt
    );
  }

  /**
   * 更新订单状态
   */
  updateOrderStatus(
    orderId: string,
    status: string,
    avgFillPrice?: number,
    totalCost?: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE orders SET
        status = ?,
        avg_fill_price = COALESCE(?, avg_fill_price),
        total_cost = COALESCE(?, total_cost),
        filled_at = CASE WHEN ? IN ('FILLED', 'PARTIAL') THEN datetime('now') ELSE filled_at END
      WHERE id = ?
    `);

    stmt.run(status, avgFillPrice, totalCost, status, orderId);
  }

  /**
   * 获取订单
   */
  getOrder(orderId: string): Order | null {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(orderId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      cycleId: row.cycle_id as string | undefined,
      side: row.side as 'UP' | 'DOWN',
      orderType: row.order_type as 'MARKET' | 'LIMIT',
      shares: row.shares as number,
      price: row.price as number | undefined,
      avgFillPrice: row.avg_fill_price as number | undefined,
      totalCost: row.total_cost as number | undefined,
      status: row.status as Order['status'],
      error: row.error as string | undefined,
      createdAt: new Date(row.created_at as string).getTime(),
      filledAt: row.filled_at
        ? new Date(row.filled_at as string).getTime()
        : undefined,
    };
  }

  // ===== 统计查询 =====

  /**
   * 获取交易统计
   */
  getTradeStatistics(startTime?: number, endTime?: number): {
    totalCycles: number;
    completedCycles: number;
    expiredCycles: number;
    totalProfit: number;
    avgProfit: number;
    winRate: number;
  } {
    let whereClause = '';
    const params: number[] = [];

    if (startTime && endTime) {
      whereClause =
        "WHERE created_at >= datetime(?, 'unixepoch', 'localtime') AND created_at <= datetime(?, 'unixepoch', 'localtime')";
      params.push(Math.floor(startTime / 1000), Math.floor(endTime / 1000));
    }

    const row = this.db
      .prepare(
        `
      SELECT
        COUNT(*) as totalCycles,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completedCycles,
        SUM(CASE WHEN status = 'ROUND_EXPIRED' THEN 1 ELSE 0 END) as expiredCycles,
        COALESCE(SUM(profit), 0) as totalProfit,
        COALESCE(AVG(profit), 0) as avgProfit,
        CAST(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) AS REAL) /
          NULLIF(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) as winRate
      FROM trade_cycles
      ${whereClause}
    `
      )
      .get(...params) as Record<string, number>;

    return {
      totalCycles: row.totalCycles || 0,
      completedCycles: row.completedCycles || 0,
      expiredCycles: row.expiredCycles || 0,
      totalProfit: row.totalProfit || 0,
      avgProfit: row.avgProfit || 0,
      winRate: row.winRate || 0,
    };
  }

  // ===== 回测结果操作 =====

  /**
   * 保存回测结果
   */
  saveBacktestResult(config: BacktestConfig, result: BacktestResult): number {
    // 保存配置快照
    const configStmt = this.db.prepare(`
      INSERT INTO config_snapshots (
        shares, sum_target, move_pct, window_min, fee_rate, spread_buffer
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const configInfo = configStmt.run(
      config.shares,
      config.sumTarget,
      config.movePct,
      config.windowMin,
      config.feeRate,
      0
    );

    // 保存回测结果
    const resultStmt = this.db.prepare(`
      INSERT INTO backtest_results (
        config_snapshot_id, start_time, end_time, initial_capital,
        total_trades, winning_trades, losing_trades, win_rate,
        total_profit, total_loss, net_profit,
        max_drawdown, max_drawdown_pct, sharpe_ratio, profit_factor,
        final_equity, return_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metrics = result.metrics;
    const resultInfo = resultStmt.run(
      configInfo.lastInsertRowid,
      config.startTime,
      config.endTime,
      config.initialCapital,
      metrics.totalTrades,
      metrics.winningTrades,
      metrics.losingTrades,
      metrics.winRate,
      metrics.totalProfit,
      metrics.totalLoss,
      metrics.netProfit,
      metrics.maxDrawdown,
      metrics.maxDrawdownPct,
      metrics.sharpeRatio,
      metrics.profitFactor,
      metrics.finalEquity,
      metrics.returnPct
    );

    return resultInfo.lastInsertRowid as number;
  }

  /**
   * 获取系统状态值
   */
  getSystemState(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM system_state WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row?.value || null;
  }

  /**
   * 设置系统状态值
   */
  setSystemState(key: string, value: string): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO system_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `
      )
      .run(key, value);
  }

  /**
   * 执行原始 SQL (用于调试)
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * 获取数据库文件路径
   */
  getDbPath(): string {
    return this.dbPath;
  }
}

// 单例实例
let dbInstance: DatabaseManager | null = null;

export function getDatabase(): DatabaseManager {
  if (!dbInstance) {
    dbInstance = new DatabaseManager();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export default DatabaseManager;
