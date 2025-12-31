/**
 * 日志系统模块
 * 使用 Winston 提供结构化日志输出
 */

import winston from 'winston';
import { format } from 'date-fns';
import path from 'path';
import fs from 'fs';

// 敏感字段列表 (SEC-002: 日志脱敏)
const SENSITIVE_FIELDS = [
  'privateKey',
  'private_key',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'password',
  'secret',
  'token',
  'authorization',
  'signature',
  'mnemonic',
  'seed',
];

// 地址相关字段 (部分脱敏)
const ADDRESS_FIELDS = ['address', 'walletAddress', 'wallet_address', 'from', 'to'];

/**
 * 脱敏单个值
 */
function redactValue(value: unknown, fieldName: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const lowerFieldName = fieldName.toLowerCase();

  // 完全敏感字段 - 完全隐藏
  if (SENSITIVE_FIELDS.some(sf => lowerFieldName.includes(sf.toLowerCase()))) {
    return '[REDACTED]';
  }

  // 地址字段 - 部分显示
  if (ADDRESS_FIELDS.some(af => lowerFieldName.includes(af.toLowerCase()))) {
    if (typeof value === 'string' && value.length > 10) {
      return `${value.slice(0, 6)}...${value.slice(-4)}`;
    }
  }

  return value;
}

/**
 * 递归脱敏对象 (SEC-002)
 */
function redactSensitiveData(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item, index) =>
        typeof item === 'object' && item !== null
          ? redactSensitiveData(item as Record<string, unknown>)
          : redactValue(item, `${key}[${index}]`)
      );
    } else if (typeof value === 'object') {
      result[key] = redactSensitiveData(value as Record<string, unknown>);
    } else {
      result[key] = redactValue(value, key);
    }
  }

  return result;
}

/**
 * Winston 脱敏格式化器
 */
const redactFormat = winston.format((info) => {
  // 脱敏 meta 数据
  const { level, message, timestamp, service, ...meta } = info;
  const redactedMeta = redactSensitiveData(meta);

  return {
    level,
    message,
    timestamp,
    service,
    ...redactedMeta,
  };
});

// 确保日志目录存在，并限制权限 (SEC-008)
const logDir = process.env.LOG_DIR || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); // 仅所有者可读写执行
} else {
  // 尝试修复现有目录权限
  try {
    fs.chmodSync(logDir, 0o700);
  } catch {
    // 忽略权限修改失败 (可能在某些系统上不支持)
  }
}

// 自定义日志格式
const customFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
});

// JSON 格式用于文件输出
const jsonFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  return JSON.stringify({
    timestamp,
    level,
    message,
    ...meta,
  });
});

// 创建 Winston logger 实例
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    }),
    winston.format.errors({ stack: true }),
    redactFormat() // 应用脱敏格式化器 (SEC-002)
  ),
  defaultMeta: { service: 'polymarket-bot' },
  transports: [
    // 控制台输出 (彩色格式)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        customFormat
      ),
    }),
    // 文件输出 (JSON 格式)
    new winston.transports.File({
      filename: path.join(logDir, 'bot.log'),
      format: winston.format.combine(jsonFormat),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // 错误日志单独文件
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: winston.format.combine(jsonFormat),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

// 交易专用日志器
export const tradeLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    }),
    redactFormat() // 应用脱敏格式化器 (SEC-002)
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'trades.log'),
      format: winston.format.combine(jsonFormat),
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
    }),
  ],
});

// 价格数据日志器 (用于回测数据收集)
export const priceLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    }),
    redactFormat() // 应用脱敏格式化器 (SEC-002)
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'prices.log'),
      format: winston.format.combine(jsonFormat),
      maxsize: 100 * 1024 * 1024, // 100MB
      maxFiles: 20,
    }),
  ],
});

/**
 * 记录关键操作到交易日志
 */
export function logTrade(
  action: string,
  data: Record<string, unknown>
): void {
  tradeLogger.info(action, {
    action,
    ...data,
    loggedAt: Date.now(),
  });
}

/**
 * 记录价格数据
 */
export function logPrice(data: Record<string, unknown>): void {
  priceLogger.info('price_snapshot', data);
}

/**
 * 创建带上下文的子日志器
 */
export function createContextLogger(context: string): winston.Logger {
  return logger.child({ context });
}

// 便捷方法
export const log = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    logger.debug(message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    logger.info(message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    logger.warn(message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    logger.error(message, meta),
  trade: logTrade,
  price: logPrice,
};

export default logger;
