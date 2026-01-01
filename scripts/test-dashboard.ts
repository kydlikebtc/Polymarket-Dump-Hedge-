#!/usr/bin/env tsx
/**
 * Dashboard 诊断脚本
 * 用于验证 blessed UI 是否正常工作
 */

import * as blessedModule from 'blessed';

// ESM/CommonJS 兼容性处理
const blessed = (blessedModule as any).default || blessedModule;

console.log('=== Dashboard 诊断 ===\n');

// 检查终端环境
console.log('1. 终端环境检查:');
console.log(`   TTY: ${process.stdout.isTTY ? '是' : '否'}`);
console.log(`   TERM: ${process.env.TERM || '未设置'}`);
console.log(`   Columns: ${process.stdout.columns || '未知'}`);
console.log(`   Rows: ${process.stdout.rows || '未知'}`);

// 检查 blessed 模块
console.log('\n2. Blessed 模块检查:');
console.log(`   blessedModule 对象: ${typeof blessedModule}`);
console.log(`   blessedModule.screen: ${typeof (blessedModule as any).screen}`);
console.log(`   blessedModule.default: ${typeof (blessedModule as any).default}`);
console.log(`   blessed (after fix): ${typeof blessed}`);
console.log(`   blessed.screen: ${typeof blessed.screen}`);
console.log(`   blessed.box: ${typeof blessed.box}`);

if (!process.stdout.isTTY) {
  console.log('\n⚠️  警告: 当前不是交互式终端，blessed UI 无法正常渲染');
  console.log('   请在真实终端中运行: npm run trading:dry');
  process.exit(0);
}

// 尝试创建一个简单的 blessed screen
console.log('\n3. 创建测试 UI...');

try {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Dashboard Test',
  });

  const box = blessed.box({
    top: 'center',
    left: 'center',
    width: '50%',
    height: '50%',
    content: '{center}Dashboard 测试成功!{/center}\n\n按 q 退出',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      bg: 'blue',
      border: { fg: 'cyan' },
    },
  });

  screen.append(box);

  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    console.log('\n✅ Dashboard UI 工作正常!');
    process.exit(0);
  });

  screen.render();
  console.log('   UI 已渲染，按 q 退出');
} catch (error) {
  console.error('\n❌ 创建 UI 失败:', error);
  process.exit(1);
}
