#!/usr/bin/env tsx
/**
 * 测试 RoundManager 的市场初始化流程
 */

import dotenv from 'dotenv';
dotenv.config();

import { RoundManager } from '../src/core/RoundManager.js';

async function testRoundManager() {
  console.log('=== RoundManager Test ===\n');

  const roundManager = new RoundManager();

  console.log('1. Check static market config...');
  const staticConfig = roundManager.getStaticMarketConfig();
  console.log('  Has static config:', !!staticConfig);
  console.log('  Condition ID:', staticConfig?.conditionId?.substring(0, 30) + '...');

  console.log('\n2. Call ensureActiveMarket()...');
  const hasMarket = await roundManager.ensureActiveMarket();
  console.log('  Has market:', hasMarket);

  console.log('\n3. Get current round info...');
  const round = roundManager.getCurrentRound();
  if (round) {
    console.log('  ✅ Round info:');
    console.log('    Slug:', round.slug);
    console.log('    Market Name:', round.marketName);
    console.log('    UP Token:', round.upTokenId?.substring(0, 30) + '...');
    console.log('    DOWN Token:', round.downTokenId?.substring(0, 30) + '...');
    console.log('    End Time:', new Date(round.endTime).toISOString());
    console.log('    Seconds Remaining:', roundManager.getSecondsRemaining());
  } else {
    console.log('  ❌ No current round');
  }

  console.log('\n4. Test getMarketName()...');
  console.log('  Market Name:', roundManager.getMarketName());

  console.log('\n=== Test Complete ===');
}

testRoundManager().catch(console.error);
