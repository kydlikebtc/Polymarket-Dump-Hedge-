/**
 * 集成测试环境设置
 * 用于测试真实 API 连接（需要有效凭据）
 */

import { beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// 加载真实环境变量
dotenv.config();

// 集成测试标记
export const isIntegrationTest = process.env.INTEGRATION_TEST === 'true';

// 检查必要的环境变量
export function requireEnvVars(...vars: string[]): boolean {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.warn(`Missing env vars for integration tests: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

// 集成测试配置
export const integrationConfig = {
  // API 端点
  clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
  gammaApiUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
  dataApiUrl: process.env.DATA_API_URL || 'https://data-api.polymarket.com',
  clobWsUrl: process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',

  // Builder 凭据
  builderApiKey: process.env.BUILDER_API_KEY,
  builderSecret: process.env.BUILDER_SECRET,
  builderPassphrase: process.env.BUILDER_PASSPHRASE,

  // 超时设置
  apiTimeout: 30000,
  wsTimeout: 10000,
};

// 检查 Builder 凭据是否可用
export const hasBuilderCreds = !!(
  integrationConfig.builderApiKey &&
  integrationConfig.builderSecret &&
  integrationConfig.builderPassphrase
);

// 跳过测试的辅助函数
export function skipIfNoBuilderCreds() {
  if (!hasBuilderCreds) {
    console.log('Skipping: Builder credentials not configured');
    return true;
  }
  return false;
}

// 集成测试前置钩子
beforeAll(() => {
  if (isIntegrationTest) {
    console.log('Running integration tests...');
    console.log(`CLOB API: ${integrationConfig.clobApiUrl}`);
    console.log(`Builder API configured: ${hasBuilderCreds}`);
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});
