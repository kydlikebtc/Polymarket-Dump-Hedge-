#!/usr/bin/env node
/**
 * 回测 CLI 入口点
 *
 * 用法:
 *   npm run backtest -- --start 2024-01-01 --end 2024-01-31
 *   npm run backtest -- --optimize --param movePct:10,15,20 --param sumTarget:0.93,0.95,0.97
 */

import { BacktestEngine } from './backtest/index.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { BacktestConfig, BacktestResult } from './types/index.js';
import * as fs from 'fs';

interface CliArgs {
  start?: string;
  end?: string;
  optimize?: boolean;
  params?: Map<string, number[]>;
  output?: string;
  format?: 'text' | 'csv' | 'json';
}

/**
 * 解析命令行参数
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    params: new Map(),
    format: 'text'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--start' && args[i + 1]) {
      result.start = args[++i];
    } else if (arg === '--end' && args[i + 1]) {
      result.end = args[++i];
    } else if (arg === '--optimize') {
      result.optimize = true;
    } else if (arg === '--param' && args[i + 1]) {
      const paramStr = args[++i];
      const [key, values] = paramStr.split(':');
      if (key && values) {
        result.params!.set(key, values.split(',').map(Number));
      }
    } else if (arg === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      result.format = args[++i] as 'text' | 'csv' | 'json';
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

/**
 * 打印帮助信息
 */
function printHelp(): void {
  console.log(`
Polymarket Dump & Hedge 回测工具

用法:
  npm run backtest -- [选项]

选项:
  --start <date>     开始日期 (YYYY-MM-DD 或 ISO 格式)
  --end <date>       结束日期 (YYYY-MM-DD 或 ISO 格式)
  --optimize         启用参数优化模式 (网格搜索)
  --param <k:v1,v2>  指定优化参数和候选值
                     例: --param movePct:10,15,20
  --output <file>    输出结果到文件
  --format <fmt>     输出格式: text, csv, json (默认: text)
  --help, -h         显示帮助信息

示例:
  # 基础回测
  npm run backtest -- --start 2024-01-01 --end 2024-01-31

  # 参数优化
  npm run backtest -- --optimize --param movePct:10,15,20 --param sumTarget:0.93,0.95

  # 导出结果
  npm run backtest -- --start 2024-01-01 --end 2024-01-31 --output results.json --format json
`);
}

/**
 * 格式化回测结果为文本
 */
function formatResultText(result: BacktestResult): string {
  const { metrics, config } = result;
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════',
    '                    回测结果报告',
    '═══════════════════════════════════════════════════════════════',
    '',
    `时间范围: ${new Date(config.startTime).toISOString()} ~ ${new Date(config.endTime).toISOString()}`,
    `初始资金: $${config.initialCapital.toFixed(2)}`,
    `最终资金: $${metrics.finalEquity.toFixed(2)}`,
    '',
    '───────────────────────────────────────────────────────────────',
    '                    交易统计',
    '───────────────────────────────────────────────────────────────',
    `总交易次数: ${metrics.totalTrades}`,
    `盈利交易: ${metrics.winningTrades}`,
    `亏损交易: ${metrics.losingTrades}`,
    `胜率: ${(metrics.winRate * 100).toFixed(2)}%`,
    '',
    '───────────────────────────────────────────────────────────────',
    '                    收益指标',
    '───────────────────────────────────────────────────────────────',
    `总收益: $${metrics.netProfit.toFixed(2)}`,
    `总收益率: ${(metrics.returnPct * 100).toFixed(2)}%`,
    `最大回撤: ${(metrics.maxDrawdown * 100).toFixed(2)}%`,
    `夏普比率: ${metrics.sharpeRatio.toFixed(4)}`,
    `盈亏比: ${metrics.profitFactor.toFixed(4)}`,
    '',
    '───────────────────────────────────────────────────────────────',
    '                    回测配置',
    '───────────────────────────────────────────────────────────────',
    `暴跌阈值: ${(config.movePct * 100).toFixed(1)}%`,
    `检测窗口: ${config.windowMin} 分钟`,
    `对冲目标: ${config.sumTarget}`,
    `初始资金: $${config.initialCapital}`,
    `每笔份数: ${config.shares}`,
    `手续费率: ${(config.feeRate * 100).toFixed(3)}%`,
    '',
    '═══════════════════════════════════════════════════════════════',
  ];

  return lines.join('\n');
}

/**
 * 格式化回测结果为 CSV
 */
function formatResultCsv(result: BacktestResult): string {
  const { metrics, config } = result;
  const headers = [
    'start_time', 'end_time', 'initial_capital', 'final_equity',
    'total_trades', 'winning_trades', 'losing_trades', 'win_rate',
    'net_profit', 'return_pct', 'max_drawdown', 'sharpe_ratio', 'profit_factor',
    'move_pct', 'window_min', 'sum_target', 'shares', 'fee_rate'
  ];

  const values = [
    config.startTime,
    config.endTime,
    config.initialCapital,
    metrics.finalEquity,
    metrics.totalTrades,
    metrics.winningTrades,
    metrics.losingTrades,
    metrics.winRate,
    metrics.netProfit,
    metrics.returnPct,
    metrics.maxDrawdown,
    metrics.sharpeRatio,
    metrics.profitFactor,
    config.movePct,
    config.windowMin,
    config.sumTarget,
    config.shares,
    config.feeRate
  ];

  return headers.join(',') + '\n' + values.join(',');
}

/**
 * 参数优化 - 网格搜索
 */
interface OptimizationResult {
  params: Record<string, number>;
  result: BacktestResult;
}

async function runOptimization(
  baseConfig: BacktestConfig,
  paramGrid: Map<string, number[]>
): Promise<OptimizationResult[]> {
  const results: OptimizationResult[] = [];

  // 生成参数组合
  const paramNames = Array.from(paramGrid.keys());
  const paramValues = Array.from(paramGrid.values());

  // 计算总组合数
  const totalCombinations = paramValues.reduce((acc, vals) => acc * vals.length, 1);
  logger.info(`开始参数优化，共 ${totalCombinations} 个参数组合`);

  // 递归生成所有组合
  function* generateCombinations(
    index: number,
    current: Record<string, number>
  ): Generator<Record<string, number>> {
    if (index === paramNames.length) {
      yield { ...current };
      return;
    }

    const paramName = paramNames[index];
    const values = paramValues[index];

    for (const value of values) {
      current[paramName] = value;
      yield* generateCombinations(index + 1, current);
    }
  }

  let completed = 0;

  for (const params of generateCombinations(0, {})) {
    // 构建配置
    const config: BacktestConfig = { ...baseConfig };

    for (const [key, value] of Object.entries(params)) {
      if (key in config) {
        (config as any)[key] = value;
      }
    }

    try {
      const engine = new BacktestEngine(config);
      engine.loadData();
      const result = engine.run();
      results.push({ params, result });

      completed++;
      logger.info(
        `[${completed}/${totalCombinations}] 参数: ${JSON.stringify(params)} ` +
        `收益率: ${(result.metrics.returnPct * 100).toFixed(2)}% ` +
        `夏普: ${result.metrics.sharpeRatio.toFixed(4)}`
      );
    } catch (error) {
      logger.error(`参数组合失败: ${JSON.stringify(params)}`, error);
    }
  }

  // 按夏普比率排序
  results.sort((a, b) => b.result.metrics.sharpeRatio - a.result.metrics.sharpeRatio);

  return results;
}

/**
 * 打印优化结果
 */
function printOptimizationResults(results: OptimizationResult[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    参数优化结果 (按夏普比率排序)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const top10 = results.slice(0, 10);

  console.log('排名\t夏普比率\t收益率\t\t胜率\t\t最大回撤\t参数');
  console.log('───────────────────────────────────────────────────────────────');

  top10.forEach((item, index) => {
    const m = item.result.metrics;
    console.log(
      `#${index + 1}\t` +
      `${m.sharpeRatio.toFixed(4)}\t\t` +
      `${(m.returnPct * 100).toFixed(2)}%\t\t` +
      `${(m.winRate * 100).toFixed(1)}%\t\t` +
      `${(m.maxDrawdown * 100).toFixed(2)}%\t\t` +
      `${JSON.stringify(item.params)}`
    );
  });

  if (results.length > 0) {
    console.log('\n最优参数组合:');
    console.log(JSON.stringify(results[0].params, null, 2));
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const args = parseArgs();

  logger.info('Polymarket Dump & Hedge 回测引擎启动');

  // 加载配置
  const botConfig = loadConfig();

  // 构建回测配置
  const baseConfig: BacktestConfig = {
    startTime: args.start ? new Date(args.start).getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000,
    endTime: args.end ? new Date(args.end).getTime() : Date.now(),
    movePct: botConfig.movePct,
    windowMin: botConfig.windowMin,
    sumTarget: botConfig.sumTarget,
    shares: botConfig.shares,
    initialCapital: 10000,
    feeRate: botConfig.feeRate,
  };

  logger.info(`回测时间范围: ${new Date(baseConfig.startTime).toISOString()} ~ ${new Date(baseConfig.endTime).toISOString()}`);

  try {
    if (args.optimize && args.params && args.params.size > 0) {
      // 参数优化模式
      const results = await runOptimization(baseConfig, args.params);
      printOptimizationResults(results);

      // 保存结果
      if (args.output) {
        const outputData = args.format === 'json'
          ? JSON.stringify(results, null, 2)
          : results.map(r => formatResultCsv(r.result)).join('\n');

        fs.writeFileSync(args.output, outputData);
        logger.info(`优化结果已保存到: ${args.output}`);
      }
    } else {
      // 单次回测模式
      const engine = new BacktestEngine(baseConfig);
      engine.loadData();
      const result = engine.run();

      // 输出结果
      let output: string;
      switch (args.format) {
        case 'json':
          output = JSON.stringify(result, null, 2);
          break;
        case 'csv':
          output = formatResultCsv(result);
          break;
        default:
          output = formatResultText(result);
      }

      console.log(output);

      // 保存到文件
      if (args.output) {
        fs.writeFileSync(args.output, output);
        logger.info(`结果已保存到: ${args.output}`);
      }

      // 打印权益曲线摘要
      if (result.equityCurve.length > 0) {
        console.log('\n权益曲线摘要 (前10个和后10个数据点):');
        const curve = result.equityCurve;
        const first10 = curve.slice(0, 10);
        const last10 = curve.slice(-10);

        console.log('时间戳\t\t\t\t权益');
        first10.forEach(point => {
          console.log(`${new Date(point.timestamp).toISOString()}\t${point.equity.toFixed(2)}`);
        });
        if (curve.length > 20) {
          console.log('...');
        }
        last10.forEach(point => {
          console.log(`${new Date(point.timestamp).toISOString()}\t${point.equity.toFixed(2)}`);
        });
      }
    }
  } catch (error) {
    logger.error('回测执行失败', error);
    process.exit(1);
  }

  logger.info('回测完成');
}

// 执行
main().catch(error => {
  logger.error('回测程序异常退出', error);
  process.exit(1);
});
