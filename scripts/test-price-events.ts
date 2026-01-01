#!/usr/bin/env tsx
/**
 * 价格事件测试 - 验证 MarketWatcher 正确处理 CLOB v2 格式并发出 price:update 事件
 */

import { MarketWatcher } from '../src/api/MarketWatcher.js';
import { eventBus } from '../src/utils/EventBus.js';
import type { PriceSnapshot } from '../src/types/index.js';

// Bitcoin Up or Down on January 1? 市场配置
const config = {
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  apiUrl: 'https://clob.polymarket.com',
  tokenIdUp: '55331466074183692834677717676010788828979064119532113495995295646897520777826',
  tokenIdDown: '25850824252464438281862640665986230433485390785186664917827449394013177041457',
  shares: 20,
  sumTarget: 0.95,
  movePct: 0.15,
  windowMin: 2,
  feeRate: 0.005,
  spreadBuffer: 0.02,
  dryRun: true,
  readOnly: false,
};

async function testPriceEvents() {
  console.log('=== Price Events Test ===\n');

  let priceUpdateCount = 0;
  const maxUpdates = 5;

  // 监听价格更新事件
  eventBus.onEvent('price:update', (snapshot: PriceSnapshot) => {
    priceUpdateCount++;
    console.log(`\n[Price Update #${priceUpdateCount}]`);
    console.log('  Round:', snapshot.roundSlug);
    console.log('  UP Best Ask:', snapshot.upBestAsk);
    console.log('  UP Best Bid:', snapshot.upBestBid);
    console.log('  DOWN Best Ask:', snapshot.downBestAsk);
    console.log('  DOWN Best Bid:', snapshot.downBestBid);
    console.log('  Sum (Ask):', (snapshot.upBestAsk + snapshot.downBestAsk).toFixed(4));
    console.log('  Timestamp:', new Date(snapshot.timestamp).toLocaleTimeString());

    if (priceUpdateCount >= maxUpdates) {
      console.log(`\n✅ Received ${maxUpdates} price updates. Test passed!`);
      process.exit(0);
    }
  });

  // 创建 MarketWatcher
  const watcher = new MarketWatcher(config as any);

  // 设置 Token IDs
  watcher.setTokenIds(config.tokenIdUp, config.tokenIdDown);

  console.log('Connecting to WebSocket...');
  await watcher.connect();

  console.log('Subscribing to tokens...');
  watcher.subscribeMultiple([config.tokenIdUp, config.tokenIdDown]);

  console.log('Waiting for price updates...\n');

  // 超时
  setTimeout(() => {
    if (priceUpdateCount === 0) {
      console.log('\n❌ Timeout - no price updates received after 20 seconds');
      process.exit(1);
    } else {
      console.log(`\n⚠️ Timeout but received ${priceUpdateCount} price updates`);
      watcher.disconnect();
      process.exit(0);
    }
  }, 20000);
}

testPriceEvents().catch(console.error);
