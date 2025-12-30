/**
 * Vitest 全局测试设置
 */

import { beforeAll, afterAll, vi } from 'vitest';

// Mock 环境变量
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.TOKEN_ID_UP = 'test-up-token';
  process.env.TOKEN_ID_DOWN = 'test-down-token';
  process.env.WS_URL = 'wss://test.com';
  process.env.API_URL = 'https://test.com';
  process.env.PRIVATE_KEY = '';
  process.env.MOVE_PCT = '0.15';
  process.env.WINDOW_MS = '3000';
  process.env.SUM_TARGET = '0.95';
  process.env.MAX_ORDER_USDC = '100';
  process.env.COOLDOWN_MS = '5000';
  process.env.DRY_RUN = 'true';
  process.env.DB_PATH = ':memory:';
});

// 清理
afterAll(() => {
  vi.restoreAllMocks();
});
