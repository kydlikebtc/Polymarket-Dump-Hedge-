#!/usr/bin/env tsx
/**
 * 静态市场 Fallback 功能测试
 */

import { loadStaticMarketConfig } from '../src/utils/config.js';
import { RoundManager } from '../src/core/RoundManager.js';

async function main() {
  console.log('=== Static Market Test ===\n');

  // 1. 测试加载静态配置
  console.log('1. Loading static market config from .env...');
  const staticConfig = loadStaticMarketConfig();
  if (staticConfig) {
    console.log('   ✅ Static market config loaded:');
    const upShort = staticConfig.upTokenId.substring(0, 30);
    const downShort = staticConfig.downTokenId.substring(0, 30);
    console.log('      upTokenId: ' + upShort + '...');
    console.log('      downTokenId: ' + downShort + '...');
  } else {
    console.log('   ❌ No static market config found');
    process.exit(1);
  }

  // 2. 测试 RoundManager 静态市场
  console.log('\n2. Testing RoundManager static market...');
  const rm = new RoundManager();
  const hasStaticConfig = rm.getStaticMarketConfig() !== null;
  console.log('   hasStaticMarket in constructor: ' + hasStaticConfig);

  // 3. 测试 ensureActiveMarket
  console.log('\n3. Testing ensureActiveMarket (should use static market)...');
  const hasMarket = await rm.ensureActiveMarket();
  console.log('   hasMarket: ' + hasMarket);
  console.log('   isUsingStaticMarket: ' + rm.isUsingStaticMarket());

  const upToken = rm.getUpTokenId();
  const downToken = rm.getDownTokenId();
  if (upToken) {
    console.log('   upTokenId: ' + upToken.substring(0, 30) + '...');
  }
  if (downToken) {
    console.log('   downTokenId: ' + downToken.substring(0, 30) + '...');
  }

  if (hasMarket && upToken && downToken) {
    console.log('\n✅ Static market fallback is working correctly!');
    process.exit(0);
  } else {
    console.log('\n❌ Static market fallback NOT working');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
