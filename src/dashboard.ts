#!/usr/bin/env node
/**
 * Polymarket Dump & Hedge Bot - Dashboard UI 入口
 *
 * 提供交互式终端界面
 *
 * 用法:
 *   npm run dashboard        # 启动 Dashboard
 *   npm run dashboard -- -d  # 调试模式
 */

import { Dashboard } from './ui/index.js';
import { TradingEngine } from './core/index.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { getDatabase, closeDatabase } from './db/index.js';

// 全局状态
let dashboard: Dashboard | null = null;
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
 * 优雅关闭
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`收到 ${signal} 信号，开始优雅关闭...`);

  try {
    // 销毁 Dashboard
    if (dashboard) {
      dashboard.destroy();
      dashboard = null;
    }

    // 停止交易引擎
    if (engine) {
      await engine.stop();
      engine = null;
    }

    // 关闭数据库
    closeDatabase();

    logger.info('优雅关闭完成');
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
  const { dryRun, debug } = parseArgs();

  // 设置日志级别
  if (debug) {
    logger.level = 'debug';
  }

  logger.info('Polymarket Dump & Hedge Dashboard 启动中...');

  // 加载配置
  const config = loadConfig();

  // 覆盖 dryRun 设置
  if (dryRun) {
    config.dryRun = true;
  }

  // 初始化数据库
  getDatabase(config.dbPath);

  // 创建 Dashboard
  dashboard = new Dashboard();

  // 创建交易引擎
  engine = new TradingEngine(config);
  dashboard.setEngine(engine);

  // 设置信号处理
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', error);
    gracefulShutdown('uncaughtException');
  });

  // 启动 Dashboard
  dashboard.start();

  // 启动交易引擎
  await engine.start();

  dashboard.log(`模式: ${config.dryRun ? '干跑 (DRY RUN)' : '实盘'}`);
}

// 执行
main().catch((error) => {
  logger.error('启动失败', error);
  if (dashboard) {
    dashboard.destroy();
  }
  process.exit(1);
});
