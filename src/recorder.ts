#!/usr/bin/env node
/**
 * Polymarket 数据录制器
 *
 * 录制市场价格数据用于回测分析
 *
 * 用法:
 *   npm run recorder        # 启动录制
 *   npm run recorder -- -d  # 调试模式
 */

import { MarketWatcher } from './api/MarketWatcher.js';
import { DatabaseManager, getDatabase } from './db/index.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { eventBus } from './utils/EventBus.js';
import { PriceSnapshot } from './types/index.js';

// 全局状态
let watcher: MarketWatcher | null = null;
let db: DatabaseManager | null = null;
let isShuttingDown = false;

// 统计
let snapshotCount = 0;
let lastLogTime = Date.now();
let batchBuffer: PriceSnapshot[] = [];
const BATCH_SIZE = 100; // 每 100 条批量写入

/**
 * 解析命令行参数
 */
function parseArgs(): { debug: boolean } {
  const args = process.argv.slice(2);
  return {
    debug: args.includes('--debug') || args.includes('-d'),
  };
}

/**
 * 打印启动信息
 */
function printBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   Polymarket Data Recorder                                    ║
║   数据录制器 - 录制市场价格数据用于回测                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
}

/**
 * 处理价格快照
 */
function handlePriceSnapshot(snapshot: PriceSnapshot): void {
  snapshotCount++;
  batchBuffer.push(snapshot);

  // 批量写入
  if (batchBuffer.length >= BATCH_SIZE) {
    flushBatch();
  }

  // 每 10 秒打印统计
  const now = Date.now();
  if (now - lastLogTime >= 10000) {
    logger.info(
      `📊 录制统计: 总计 ${snapshotCount} 条 | ` +
      `缓冲 ${batchBuffer.length} 条 | ` +
      `当前 UP=${snapshot.upPrice.toFixed(4)} DOWN=${snapshot.downPrice.toFixed(4)}`
    );
    lastLogTime = now;
  }
}

/**
 * 批量写入数据库
 */
function flushBatch(): void {
  if (!db || batchBuffer.length === 0) return;

  try {
    db.insertPriceSnapshots(batchBuffer);
    logger.debug(`批量写入 ${batchBuffer.length} 条快照`);
    batchBuffer = [];
  } catch (error) {
    logger.error('批量写入失败', error);
  }
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
    // 停止 WebSocket
    if (watcher) {
      logger.info('停止 WebSocket 连接...');
      watcher.stop();
      watcher = null;
    }

    // 刷新缓冲
    logger.info(`刷新剩余 ${batchBuffer.length} 条缓冲数据...`);
    flushBatch();

    // 打印最终统计
    logger.info(`✅ 录制完成，共录制 ${snapshotCount} 条数据`);

    process.exit(0);
  } catch (error) {
    logger.error('关闭过程中发生错误', error);
    process.exit(1);
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const { debug } = parseArgs();

  // 打印 Banner
  printBanner();

  // 设置日志级别
  if (debug) {
    logger.level = 'debug';
  }

  logger.info('Polymarket 数据录制器启动中...');

  // 加载配置
  const config = loadConfig();
  logger.info(`配置加载完成`);
  logger.info(`UP Token: ${config.tokenIdUp}`);
  logger.info(`DOWN Token: ${config.tokenIdDown}`);

  // 初始化数据库
  logger.info('初始化数据库...');
  db = getDatabase(config.dbPath);
  logger.info(`数据库路径: ${config.dbPath}`);

  // 设置事件监听
  eventBus.on('price:update', handlePriceSnapshot);

  eventBus.on('ws:connected', () => {
    logger.info('📡 WebSocket 已连接');
  });

  eventBus.on('ws:disconnected', () => {
    logger.warn('📡 WebSocket 断开连接');
    // 刷新缓冲，防止数据丢失
    flushBatch();
  });

  eventBus.on('ws:reconnecting', (attempt: number) => {
    logger.info(`📡 WebSocket 重连中... 尝试 #${attempt}`);
  });

  eventBus.on('ws:error', (error: Error) => {
    logger.error(`WebSocket 错误: ${error.message}`);
  });

  // 设置信号处理
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', error);
    gracefulShutdown('uncaughtException');
  });

  // 创建并启动 MarketWatcher
  logger.info('启动 WebSocket 连接...');
  watcher = new MarketWatcher(
    config.wsUrl,
    config.tokenIdUp,
    config.tokenIdDown,
    config.windowMs
  );

  await watcher.start();

  // 定期刷新缓冲
  setInterval(() => {
    flushBatch();
  }, 5000); // 每 5 秒刷新一次

  logger.info('✅ 数据录制器启动完成，开始录制...');
  logger.info('按 Ctrl+C 停止录制');

  // 保持进程运行
  process.stdin.resume();
}

// 执行
main().catch((error) => {
  logger.error('启动失败', error);
  process.exit(1);
});
