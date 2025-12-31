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
import type {
  PriceSnapshot,
  DumpSignal,
  TradeCycle,
  Order,
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
  eventBus.onEvent('price:update', (snapshot: PriceSnapshot) => {
    logger.debug(
      `价格更新: UP=${snapshot.upBestAsk.toFixed(4)} DOWN=${snapshot.downBestAsk.toFixed(4)} ` +
      `SUM=${(snapshot.upBestAsk + snapshot.downBestAsk).toFixed(4)}`
    );
  });

  // 暴跌信号
  eventBus.onEvent('price:dump_detected', (signal: DumpSignal) => {
    logger.warn(
      `🚨 暴跌检测! Side=${signal.side} 从 ${signal.previousPrice.toFixed(4)} 跌至 ${signal.price.toFixed(4)} ` +
      `跌幅=${(signal.dropPct * 100).toFixed(2)}%`
    );
  });

  // 订单事件
  eventBus.onEvent('order:submitted', (order: Order) => {
    logger.info(
      `订单提交: ${order.side} ${order.shares} shares @ ${order.price?.toFixed(4) || 'MKT'} ` +
      `[${order.orderType}] ID=${order.id}`
    );
  });

  eventBus.onEvent('order:filled', (order: Order) => {
    logger.info(
      `✅ 订单成交: ${order.side} ${order.shares} @ ${order.avgFillPrice?.toFixed(4)} ` +
      `成本=$${order.totalCost?.toFixed(2)}`
    );
  });

  eventBus.onEvent('order:error', (data: { order: Order; error: Error }) => {
    logger.error(`❌ 订单失败: ${data.order.id} - ${data.error.message}`);
  });

  // 交易周期事件
  eventBus.onEvent('cycle:completed', ({ cycle, profit }: { cycle: TradeCycle; profit: number }) => {
    logger.info(
      `🎉 交易周期完成! ID=${cycle.id} 净利润=$${profit.toFixed(2)} ` +
      `Leg1=${cycle.leg1?.entryPrice.toFixed(4)} Leg2=${cycle.leg2?.entryPrice.toFixed(4)}`
    );
  });

  // 回合事件
  eventBus.onEvent('round:new', (data: { roundSlug: string; startTime: number }) => {
    logger.info(`📅 新回合开始: ${data.roundSlug}`);
  });

  eventBus.onEvent('round:expired', () => {
    logger.warn(`⏰ 回合过期`);
  });

  // 错误事件
  eventBus.onEvent('system:error', (error: Error) => {
    logger.error(`系统错误: ${error.message}`, { stack: error.stack });
  });

  // WebSocket 事件
  eventBus.onEvent('ws:connected', () => {
    logger.info('📡 WebSocket 已连接');
  });

  eventBus.onEvent('ws:disconnected', () => {
    logger.warn('📡 WebSocket 断开连接');
  });

  eventBus.onEvent('ws:reconnecting', ({ attempt }) => {
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

  const isRunning = engine.isEngineRunning();
  const currentState = engine.getStateMachine().getCurrentStatus();
  const currentCycle = engine.getStateMachine().getCurrentCycle();
  const currentRound = engine.getRoundManager().getCurrentRoundSlug();
  const latestPrice = engine.getMarketWatcher().getLatestPrice();

  console.log('\n───────────────────────────────────────');
  console.log('              当前状态');
  console.log('───────────────────────────────────────');
  console.log(`运行状态: ${isRunning ? '运行中 ✅' : '已停止 ❌'}`);
  console.log(`当前状态: ${currentState}`);
  console.log(`当前回合: ${currentRound || 'N/A'}`);

  if (latestPrice) {
    console.log(`当前价格: UP=${latestPrice.upBestAsk.toFixed(4)} DOWN=${latestPrice.downBestAsk.toFixed(4)}`);
    console.log(`价格和: ${(latestPrice.upBestAsk + latestPrice.downBestAsk).toFixed(4)}`);
  }

  if (currentCycle) {
    console.log(`活跃周期: ${currentCycle.id}`);
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
  getDatabase();
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
