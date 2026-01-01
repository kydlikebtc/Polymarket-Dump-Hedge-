#!/usr/bin/env tsx
/**
 * 测试通过 Condition ID 从 API 动态获取市场信息
 */

import { MarketDiscoveryService } from '../src/api/MarketDiscoveryService.js';
import dotenv from 'dotenv';

dotenv.config();

const CONDITION_ID = process.env.CONDITION_ID || '0x75e5517cb9f10afc8592fd283fd7cdc7da544e9bb9212586928b4015f7125271';

async function testMarketFetch() {
  console.log('=== Market Fetch Test ===\n');
  console.log('CONDITION_ID:', CONDITION_ID.substring(0, 30) + '...\n');

  const discoveryService = new MarketDiscoveryService();

  console.log('Fetching market info from Gamma API...\n');

  const market = await discoveryService.fetchMarketByConditionId(CONDITION_ID);

  if (!market) {
    console.log('❌ Failed to fetch market info');
    process.exit(1);
  }

  console.log('✅ Market info fetched successfully!\n');
  console.log('=== Market Details ===');
  console.log('  Question:', market.question);
  console.log('  Slug:', market.slug);
  console.log('  Status:', market.status);
  console.log('  UP Token:', market.upTokenId.substring(0, 40) + '...');
  console.log('  DOWN Token:', market.downTokenId.substring(0, 40) + '...');
  console.log('  Start Time:', new Date(market.startTime).toISOString());
  console.log('  End Time:', new Date(market.endTime).toISOString());
  console.log('  Outcomes:', market.outcomes.join(', '));
  console.log('  Prices:', market.outcomePrices.join(', '));

  const now = Date.now();
  const remaining = market.endTime - now;
  if (remaining > 0) {
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    console.log('  Remaining:', `${hours}h ${minutes}m`);
  } else {
    console.log('  Remaining: EXPIRED');
  }

  console.log('\n=== Test Complete ===');
}

testMarketFetch().catch(console.error);
