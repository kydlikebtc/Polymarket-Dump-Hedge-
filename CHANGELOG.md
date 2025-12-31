# Changelog

本文档记录 Polymarket Dump & Hedge Bot 的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

---

## [0.1.0] - 2025-12-31

### 新增

#### 核心功能
- **交易引擎** - 完整的交易状态机，支持 IDLE → WATCHING → LEG1 → LEG2 → COMPLETED 流程
- **暴跌检测** - 滑动窗口算法检测 3 秒内价格暴跌信号
- **自动对冲** - 满足 sumTarget 条件时自动执行 Leg2 对冲交易
- **轮次管理** - 自动切换 BTC 15分钟预测市场轮次
- **市场监控** - WebSocket 实时价格订阅，毫秒级响应
- **订单执行** - 支持市价单和限价单

#### 对冲策略增强
- **概率预测** - 多因子分析预测对冲成功概率
- **时间估算** - 预估对冲达成所需时间
- **推荐生成** - 根据市场条件生成操作建议
- **波动率计算** - 实时波动率分析
- **趋势分析** - 价格趋势方向判断
- **价差健康度** - 买卖价差分析

#### Builder API 支持
- **订单归属** - 支持 Polymarket Builder API 实现订单归因
- **HMAC 签名** - 完整的 HMAC-SHA256 请求签名机制
- **凭据配置** - 支持 BUILDER_API_KEY, BUILDER_SECRET, BUILDER_PASSPHRASE

#### 告警系统
- **多渠道告警** - Console / Telegram Bot / Discord Webhook
- **分级告警** - info / warning / critical 三级
- **智能节流** - 可配置时间窗口内的最大告警数
- **静默时段** - 支持免打扰时间配置
- **预定义模板** - 暴跌检测、交易完成、订单失败等告警模板

#### 告警类型
- `dump_detected` - 暴跌信号检测
- `trade_completed` - 交易周期完成
- `order_failed` - 订单执行失败
- `ws_disconnected` - WebSocket 断开
- `insufficient_funds` - 余额不足
- `round_expired_loss` - 回合过期亏损
- `system_error` - 系统错误

#### Dashboard 交互
- **终端 UI** - blessed 打造的交互式终端界面
- **实时更新** - 价格、状态、日志实时刷新
- **手动买入** - 支持 UP/DOWN 手动交易
- **参数调整** - 运行时动态修改交易参数
- **告警面板** - 显示告警统计和历史

#### Dashboard 快捷键
- `s` - 启动/停止交易引擎
- `u` - 手动买入 UP
- `d` - 手动买入 DOWN
- `p` - 调整运行时参数
- `r` - 刷新显示
- `c` - 清空日志
- `q` - 退出

#### 回测系统
- **回测引擎** - 历史数据回放验证策略
- **参数优化** - 网格搜索最优参数组合
- **性能指标** - 收益率、夏普比率、最大回撤、胜率

#### 测试套件
- **单元测试** - 259 个测试用例，~72% 覆盖率
- **集成测试** - API 集成测试框架
- **端到端测试** - 完整交易流程 E2E 测试
- **性能测试** - 基准性能测试

#### 安全增强
- **SEC-001** - 私钥内存清理
- **SEC-002** - 敏感日志脱敏
- **SEC-003** - HTTPS 证书验证
- **SEC-005** - 安全随机 UUID
- **SEC-006** - 增强签名机制 (nonce + timestamp + method + path + body hash)
- **SEC-008** - 日志文件权限控制
- **SEC-009** - 环境变量边界检查

#### 配置系统
- **环境变量** - 完整的 .env 配置支持
- **类型安全** - TypeScript 类型定义
- **边界验证** - 数字参数范围检查
- **模式切换** - READ_ONLY / DRY_RUN 模式

#### 工具模块
- **CircularBuffer** - 高性能环形缓冲区
- **EventBus** - 类型安全的事件总线
- **Logger** - 结构化日志 (支持 JSON 格式)
- **AlertManager** - 多渠道告警管理器

#### 文档
- **README.md** - 项目文档和 API 参考
- **DEPLOYMENT.md** - 部署指南
- **CHANGELOG.md** - 更新日志

### 技术栈
- Node.js >= 20.0.0
- TypeScript 5.x
- Vitest (测试框架)
- blessed (终端 UI)
- better-sqlite3 (数据库)
- ws (WebSocket)

---

## 开发计划

### v0.2.0 (计划)
- [ ] Web Dashboard 可视化界面
- [ ] 多市场支持 (ETH, SOL 等)
- [ ] 高级风控策略
- [ ] 资金管理模块

### v0.3.0 (计划)
- [ ] 机器学习价格预测
- [ ] 自动参数调优
- [ ] 分布式部署支持
- [ ] 移动端告警 App

---

## 贡献者

- Kyd - 项目作者

---

[Unreleased]: https://github.com/user/pmdumphedge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/user/pmdumphedge/releases/tag/v0.1.0
