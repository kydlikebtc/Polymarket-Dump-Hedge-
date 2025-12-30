/**
 * 配置管理模块
 * 加载环境变量并提供类型安全的配置访问
 */

import dotenv from 'dotenv';
import type { BotConfig } from '../types/index.js';
import { logger } from './logger.js';

// 加载 .env 文件
dotenv.config();

/**
 * 获取环境变量，支持默认值
 */
function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * 获取数字类型的环境变量
 */
function getEnvNumber(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return parsed;
}

/**
 * 获取布尔类型的环境变量
 */
function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * 验证配置值是否在有效范围内
 */
function validateConfig(config: BotConfig): void {
  // 验证交易参数
  if (config.shares <= 0) {
    throw new Error('shares must be positive');
  }
  if (config.sumTarget < 0.5 || config.sumTarget > 1.0) {
    throw new Error('sumTarget must be between 0.5 and 1.0');
  }
  if (config.movePct < 0.01 || config.movePct > 0.30) {
    throw new Error('movePct must be between 0.01 and 0.30');
  }
  if (config.windowMin < 1 || config.windowMin > 15) {
    throw new Error('windowMin must be between 1 and 15');
  }

  // 验证网络配置
  if (!config.wsUrl.startsWith('wss://')) {
    throw new Error('wsUrl must start with wss://');
  }
  if (!config.apiUrl.startsWith('https://')) {
    throw new Error('apiUrl must start with https://');
  }

  // 验证钱包配置 (非只读模式)
  if (!config.readOnly && !config.dryRun) {
    if (!config.privateKey) {
      throw new Error('privateKey is required for trading mode');
    }
    if (!config.walletAddress) {
      throw new Error('walletAddress is required for trading mode');
    }
  }

  logger.debug('Configuration validated successfully', {
    shares: config.shares,
    sumTarget: config.sumTarget,
    movePct: config.movePct,
    windowMin: config.windowMin,
    readOnly: config.readOnly,
    dryRun: config.dryRun,
  });
}

/**
 * 加载完整配置
 */
export function loadConfig(): BotConfig {
  logger.info('Loading configuration from environment variables');

  const config: BotConfig = {
    // 交易参数
    shares: getEnvNumber('DEFAULT_SHARES', 20),
    sumTarget: getEnvNumber('SUM_TARGET', 0.95),
    movePct: getEnvNumber('MOVE_PCT', 0.15),
    windowMin: getEnvNumber('WINDOW_MIN', 2),

    // 网络配置
    wsUrl: getEnv('WS_URL', 'wss://clob.polymarket.com/ws/market'),
    apiUrl: getEnv('API_URL', 'https://clob.polymarket.com'),
    reconnectDelay: getEnvNumber('RECONNECT_DELAY', 1000),
    maxReconnects: getEnvNumber('MAX_RECONNECTS', 5),

    // 费用参数
    feeRate: getEnvNumber('FEE_RATE', 0.005),
    spreadBuffer: getEnvNumber('SPREAD_BUFFER', 0.02),

    // 钱包配置
    privateKey: getEnv('PRIVATE_KEY', ''),
    walletAddress: getEnv('WALLET_ADDRESS', ''),

    // 运行模式
    readOnly: getEnvBoolean('READ_ONLY', false),
    dryRun: getEnvBoolean('DRY_RUN', false),
  };

  validateConfig(config);

  logger.info('Configuration loaded successfully', {
    mode: config.dryRun ? 'dry-run' : config.readOnly ? 'read-only' : 'live',
    shares: config.shares,
    sumTarget: config.sumTarget,
    movePct: `${config.movePct * 100}%`,
    windowMin: `${config.windowMin} min`,
  });

  return config;
}

/**
 * 运行时更新配置参数
 */
export function updateConfigParam(
  config: BotConfig,
  param: keyof Pick<BotConfig, 'shares' | 'sumTarget' | 'movePct' | 'windowMin'>,
  value: number
): BotConfig {
  const newConfig = { ...config, [param]: value };
  validateConfig(newConfig);

  logger.info(`Configuration parameter updated: ${param} = ${value}`, {
    oldValue: config[param],
    newValue: value,
  });

  return newConfig;
}

/**
 * 单例配置实例
 */
let configInstance: BotConfig | null = null;

export function getConfig(): BotConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function setConfig(config: BotConfig): void {
  validateConfig(config);
  configInstance = config;
}
