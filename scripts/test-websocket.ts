#!/usr/bin/env tsx
/**
 * WebSocket 连接和订阅测试
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// 从 .env 读取的 Token IDs
const TOKEN_ID_UP = '78490642434213550855600439825729670852317345211936381977390919619271067452728';
const TOKEN_ID_DOWN = '4960072122879914031540087398045925546763584182114633893203762140348078315559';

async function testWebSocket() {
  console.log('=== WebSocket Connection Test ===\n');
  console.log('Connecting to:', WS_URL);
  console.log('UP Token:', TOKEN_ID_UP.substring(0, 30) + '...');
  console.log('DOWN Token:', TOKEN_ID_DOWN.substring(0, 30) + '...');

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('\n✅ WebSocket connected!\n');

    // 使用正确的 Polymarket CLOB WebSocket 格式批量订阅
    const subscribeMessage = JSON.stringify({
      type: 'MARKET',
      assets_ids: [TOKEN_ID_UP, TOKEN_ID_DOWN],
    });
    console.log('Subscribing (CLOB v2 format):', subscribeMessage.substring(0, 100) + '...');
    ws.send(subscribeMessage);
  });

  let messageCount = 0;
  const maxMessages = 10;

  ws.on('message', (data: Buffer) => {
    messageCount++;
    const msg = data.toString();

    try {
      const parsed = JSON.parse(msg);

      // 处理数组格式 (Polymarket 实际返回格式)
      if (Array.isArray(parsed)) {
        console.log(`\n[Message ${messageCount}] Array with ${parsed.length} items:`);
        for (const item of parsed.slice(0, 3)) {
          console.log('  - Asset ID:', item.asset_id?.substring(0, 30) + '...');
          console.log('    Event:', item.event_type || 'N/A');
          console.log('    Price:', item.price || 'N/A');
          if (item.bids) console.log('    Bids:', item.bids.length);
          if (item.asks) console.log('    Asks:', item.asks.length);
          if (item.hash) console.log('    Hash:', item.hash?.substring(0, 20) + '...');
        }
      } else {
        console.log(`\n[Message ${messageCount}] Type: ${parsed.type || parsed.event || 'unknown'}`);
        console.log('  Keys:', Object.keys(parsed).join(', '));
        console.log('  Raw:', msg.substring(0, 300));
      }
    } catch {
      console.log(`\n[Message ${messageCount}] Raw:`, msg.substring(0, 300));
    }

    if (messageCount >= maxMessages) {
      console.log('\n✅ Received', maxMessages, 'messages. Test passed!');
      ws.close();
      process.exit(0);
    }
  });

  ws.on('error', (error) => {
    console.error('\n❌ WebSocket error:', error.message);
  });

  ws.on('close', (code, reason) => {
    console.log('\n⚠️ WebSocket closed:', code, reason.toString());
    if (messageCount < maxMessages) {
      console.log('❌ Did not receive expected messages');
      process.exit(1);
    }
  });

  // 超时
  setTimeout(() => {
    if (messageCount === 0) {
      console.log('\n❌ Timeout - no messages received after 15 seconds');
      ws.close();
      process.exit(1);
    } else {
      console.log('\n⚠️ Timeout but received', messageCount, 'messages');
      ws.close();
      process.exit(0);
    }
  }, 15000);
}

testWebSocket().catch(console.error);
