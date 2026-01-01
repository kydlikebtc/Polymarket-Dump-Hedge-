#!/usr/bin/env node
/**
 * Polymarket Dump & Hedge Bot - Trading Dashboard v0.2.0
 *
 * 专业交易面板入口 - 支持自动市场发现和轮换
 *
 * 用法:
 *   npm run trading         # 启动 Trading Dashboard
 *   npm run trading -- --dry  # Dry-Run 模式
 */

import { TradingDashboard } from './ui/index.js';
import { TradingEngine } from './core/index.js';
import { loadConfig, loadAlertConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { getDatabase, closeDatabase } from './db/index.js';
import { initAlertManager } from './utils/AlertManager.js';

// 全局状态
let dashboard: TradingDashboard | null = null;
let engine: TradingEngine | null = null;
let isShuttingDown = false;

/**
 * 解析命令行参数
 */
function parseArgs(): { dryRun: boolean; debug: boolean; autoDiscover: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry') || args.includes('--dry-run'),
    debug: args.includes('--debug') || args.includes('-d'),
    autoDiscover: !args.includes('--no-auto-discover'),
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
  const { dryRun, debug, autoDiscover } = parseArgs();

  // 设置日志级别
  if (debug) {
    logger.level = 'debug';
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║    BTC 15m Trading Dashboard v0.2.0                ║');
  console.log('║    Polymarket Dump & Hedge Bot                     ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  logger.info('Trading Dashboard 启动中...', {
    dryRun,
    debug,
    autoDiscover,
  });

  // 加载配置
  const config = loadConfig();

  // 覆盖 dryRun 设置
  if (dryRun) {
    config.dryRun = true;
    console.log('🔸 模式: Dry-Run (模拟交易)');
  } else {
    console.log('🔴 模式: 实盘 (真实交易)');
  }

  if (autoDiscover) {
    console.log('🔄 市场发现: 自动轮换已启用');
  }

  console.log('');

  // 初始化告警管理器
  const alertConfig = loadAlertConfig();
  initAlertManager(alertConfig);

  // 初始化数据库
  getDatabase();

  // 创建 Trading Dashboard
  dashboard = new TradingDashboard();

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

  // 启用自动发现
  if (autoDiscover) {
    const roundManager = engine.getRoundManager();
    roundManager.enableAutoDiscover(async (market) => {
      logger.info('自动轮换到新市场', {
        slug: market.slug,
        question: market.question.substring(0, 50) + '...',
        endTime: new Date(market.endTime).toISOString(),
      });
    });
  }

  // 启动 Dashboard
  dashboard.start();

  // 启动交易引擎
  await engine.start();

  logger.info('Trading Dashboard 已启动', {
    mode: config.dryRun ? 'DRY_RUN' : 'LIVE',
    autoDiscover,
  });
}

// 执行
main().catch((error) => {
  logger.error('启动失败', error);
  if (dashboard) {
    dashboard.destroy();
  }
  process.exit(1);
});
