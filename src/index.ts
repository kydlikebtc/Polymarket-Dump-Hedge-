#!/usr/bin/env node
/**
 * Polymarket Dump & Hedge Bot 主入口点
 *
 * 用法:
 *   npm run bot           # 启动交易机器人
 *   npm run bot -- --dry  # 干跑模式 (不提交真实订单)
 */

import { TradingEngine } from './core/index.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { eventBus } from './utils/EventBus.js';
import { getDatabase, closeDatabase } from './db/index.js';
import {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
  CycleStatus,
} from './types/index.js';

// 全局状态
let engine: TradingEngine | null = null;
let isShuttingDown = false;

/**
 * 解析命令行参数
 */
function parseArgs(): { dryRun: boolean; debug: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry') || args.includes('--dry-run'),
    debug: args.includes('--debug') || args.includes('-d'),
  };
}

/**
 * 打印启动 Banner
 */
function printBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██████╗ ██╗   ██╗███╗   ███╗██████╗                        ║
║   ██╔══██╗██║   ██║████╗ ████║██╔══██╗                       ║
║   ██║  ██║██║   ██║██╔████╔██║██████╔╝                       ║
║   ██║  ██║██║   ██║██║╚██╔╝██║██╔═══╝                        ║
║   ██████╔╝╚██████╔╝██║ ╚═╝ ██║██║                            ║
║   ╚═════╝  ╚═════╝ ╚═╝     ╚═╝╚═╝                            ║
║                                                               ║
║   ██╗  ██╗███████╗██████╗  ██████╗ ███████╗                  ║
║   ██║  ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝                  ║
║   ███████║█████╗  ██║  ██║██║  ███╗█████╗                    ║
║   ██╔══██║██╔══╝  ██║  ██║██║   ██║██╔══╝                    ║
║   ██║  ██║███████╗██████╔╝╚██████╔╝███████╗                  ║
║   ╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝                  ║
║                                                               ║
║   Polymarket Dump & Hedge Automated Trading Bot               ║
║   Version: 1.0.0                                              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
}

/**
 * 设置事件监听器
 */
function setupEventListeners(): void {
  // 价格更新
  eventBus.on('price:update', (snapshot: PriceSnapshot) => {
    logger.debug(
      `价格更新: UP=${snapshot.upPrice.toFixed(4)} DOWN=${snapshot.downPrice.toFixed(4)} ` +
      `SUM=${(snapshot.upPrice + snapshot.downPrice).toFixed(4)}`
    );
  });

  // 暴跌信号
  eventBus.on('dump:detected', (signal: DumpSignal) => {
    logger.warn(
      `🚨 暴跌检测! Side=${signal.side} 从 ${signal.startPrice.toFixed(4)} 跌至 ${signal.endPrice.toFixed(4)} ` +
      `跌幅=${(signal.pctChange * 100).toFixed(2)}% 耗时=${signal.durationMs}ms`
    );
  });

  // 状态变化
  eventBus.on('state:change', (data: { from: CycleStatus; to: CycleStatus; cycleId: string }) => {
    logger.info(`状态变化: ${data.from} → ${data.to} [Cycle: ${data.cycleId}]`);
  });

  // 订单事件
  eventBus.on('order:submitted', (order: Order) => {
    logger.info(
      `订单提交: ${order.side} ${order.shares} shares @ ${order.price.toFixed(4)} ` +
      `[${order.orderType}] ID=${order.orderId}`
    );
  });

  eventBus.on('order:filled', (order: Order) => {
    logger.info(
      `✅ 订单成交: ${order.side} ${order.shares} @ ${order.fillPrice?.toFixed(4)} ` +
      `成本=$${order.totalCost?.toFixed(2)}`
    );
  });

  eventBus.on('order:failed', (data: { order: Order; error: string }) => {
    logger.error(`❌ 订单失败: ${data.order.orderId} - ${data.error}`);
  });

  // 交易周期事件
  eventBus.on('cycle:completed', (cycle: TradeCycle) => {
    logger.info(
      `🎉 交易周期完成! ID=${cycle.id} 净利润=$${cycle.netProfit?.toFixed(2)} ` +
      `Leg1=${cycle.leg1Price?.toFixed(4)} Leg2=${cycle.leg2Price?.toFixed(4)}`
    );
  });

  // 回合事件
  eventBus.on('round:new', (data: { roundId: string; endTime: number }) => {
    const remaining = Math.floor((data.endTime - Date.now()) / 1000);
    logger.info(`📅 新回合开始: ${data.roundId} 剩余 ${remaining} 秒`);
  });

  eventBus.on('round:expired', (roundId: string) => {
    logger.warn(`⏰ 回合过期: ${roundId}`);
  });

  // 错误事件
  eventBus.on('error', (error: Error) => {
    logger.error(`系统错误: ${error.message}`, { stack: error.stack });
  });

  // WebSocket 事件
  eventBus.on('ws:connected', () => {
    logger.info('📡 WebSocket 已连接');
  });

  eventBus.on('ws:disconnected', () => {
    logger.warn('📡 WebSocket 断开连接');
  });

  eventBus.on('ws:reconnecting', (attempt: number) => {
    logger.info(`📡 WebSocket 重连中... 尝试 #${attempt}`);
  });
}

/**
 * 优雅关闭
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('已在关闭中，请稍候...');
    return;
  }

  isShuttingDown = true;
  logger.info(`收到 ${signal} 信号，开始优雅关闭...`);

  try {
    // 停止交易引擎
    if (engine) {
      logger.info('停止交易引擎...');
      await engine.stop();
      engine = null;
    }

    // 关闭数据库
    logger.info('关闭数据库连接...');
    closeDatabase();

    logger.info('✅ 优雅关闭完成');
    process.exit(0);
  } catch (error) {
    logger.error('关闭过程中发生错误', error);
    process.exit(1);
  }
}

/**
 * 打印状态摘要
 */
function printStatusSummary(): void {
  if (!engine) return;

  const status = engine.getStatus();

  console.log('\n───────────────────────────────────────');
  console.log('              当前状态');
  console.log('───────────────────────────────────────');
  console.log(`运行状态: ${status.isRunning ? '运行中 ✅' : '已停止 ❌'}`);
  console.log(`当前状态: ${status.currentState}`);
  console.log(`当前回合: ${status.currentRound || 'N/A'}`);

  if (status.currentPrice) {
    console.log(`当前价格: UP=${status.currentPrice.up.toFixed(4)} DOWN=${status.currentPrice.down.toFixed(4)}`);
    console.log(`价格和: ${(status.currentPrice.up + status.currentPrice.down).toFixed(4)}`);
  }

  if (status.activeCycle) {
    console.log(`活跃周期: ${status.activeCycle}`);
  }

  console.log('───────────────────────────────────────\n');
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const { dryRun, debug } = parseArgs();

  // 打印 Banner
  printBanner();

  // 设置日志级别
  if (debug) {
    logger.level = 'debug';
  }

  logger.info('Polymarket Dump & Hedge Bot 启动中...');
  logger.info(`模式: ${dryRun ? '干跑 (DRY RUN)' : '实盘'}`);

  // 在加载配置前设置 DRY_RUN 环境变量（使命令行参数生效）
  if (dryRun) {
    process.env.DRY_RUN = 'true';
  }

  // 加载配置
  const config = loadConfig();
  logger.info(`配置加载完成: movePct=${config.movePct}, sumTarget=${config.sumTarget}`);

  // 初始化数据库
  logger.info('初始化数据库...');
  const db = getDatabase(config.dbPath);
  logger.info('数据库初始化完成');

  // 设置事件监听
  setupEventListeners();

  // 创建交易引擎
  logger.info('创建交易引擎...');
  engine = new TradingEngine(config);

  // 设置信号处理
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', error);
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason });
    gracefulShutdown('unhandledRejection');
  });

  // 启动引擎
  logger.info('启动交易引擎...');
  await engine.start();

  // 定期打印状态
  setInterval(() => {
    printStatusSummary();
  }, 60000); // 每分钟打印一次

  // 初始状态打印
  setTimeout(() => {
    printStatusSummary();
  }, 5000);

  logger.info('✅ Bot 启动完成，开始监控市场...');

  // 保持进程运行
  process.stdin.resume();
}

// 执行
main().catch((error) => {
  logger.error('启动失败', error);
  process.exit(1);
});
