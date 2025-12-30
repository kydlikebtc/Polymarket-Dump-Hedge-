/**
 * 数据库迁移脚本
 * 运行: npm run db:migrate
 */

import { getDatabase, closeDatabase } from './Database.js';
import { logger } from '../utils/logger.js';

async function migrate(): Promise<void> {
  logger.info('Starting database migration...');

  try {
    const db = getDatabase();

    // Schema 已在 Database 构造函数中初始化
    // 这里可以添加额外的迁移逻辑

    // 设置 schema 版本
    db.setSystemState('schema_version', '1.0.0');
    db.setSystemState('last_migration', new Date().toISOString());

    logger.info('Database migration completed successfully');
    logger.info(`Database path: ${db.getDbPath()}`);

    // 获取表统计
    const stats = db.getTradeStatistics();
    logger.info('Database statistics:', stats);

  } catch (error) {
    logger.error('Migration failed:', { error });
    throw error;
  } finally {
    closeDatabase();
  }
}

// 直接运行时执行迁移
migrate().catch((error) => {
  console.error('Migration error:', error);
  process.exit(1);
});
