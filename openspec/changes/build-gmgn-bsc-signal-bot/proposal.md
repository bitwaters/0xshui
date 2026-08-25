## Why

BSC Meme 代币在 Bonding Curve 和 1m 热榜阶段变化极快，人工盯盘难以及时、持续地发现兼具启动动量与基础安全条件的候选。需要一个只依赖 GMGN、只负责 Telegram 信号的轻量系统，在不引入复杂评分、自动交易和多数据源维护成本的前提下，提供秒级发现、硬风险过滤以及可验证的信号质量统计。

## What Changes

- 新建一个仅支持 BSC 的单进程 Telegram 信号机器人，生产环境通过项目内 HTTP Client 直接访问 GMGN OpenAPI。
- 使用一个 1 秒 Tick 固定轮转 GMGN Trenches、1m Top100 和 5m Top100（`Trenches → 1m → Trenches → 5m`）；按地址合并为可重放的新鲜快照。
- 使用三条简单布尔路径识别 Bonding Curve 加速、1m 极速突破和跨来源启动，不构建综合热门评分。
- 仅对接近触发的候选调用 GMGN Token Security，并以 Honeypot、合约权限、税率、持仓集中度、Dev、Bundler、Insider、LP 等硬条件决定是否放行。
- 发送简洁的 Telegram 首次信号卡片；双榜持续增强时编辑原消息，配合单币、Creator 和全局限频控制噪音。
- 记录信号后 15m/1h 结果，提供推送量、命中率、涨幅、MFE/MAE、覆盖率和延迟统计。
- 将变化快照、Security 结果、配置版本和信号结果保存到 SQLite，以同一事件顺序进行确定性回算和参数比较。
- 加入 Schema 失败关闭、429 全局冷却、请求超时、持久化去重、Telegram 模糊发送保护、数据陈旧和存储异常降级，并在正式推送前完成 72 小时影子运行。
- V1 明确不包含 Solana、Bitquery、GoPlus、Market Signal、Hot Search、钱包跟踪、自动交易、微服务或复杂评分；未来交易模块只消费已产生的信号事件。

## Capabilities

### New Capabilities

- `gmgn-market-ingestion`: 直接鉴权访问 GMGN BSC Trenches、1m/5m Rank、Token Security、Kline 和 Pool，完成限速、Schema 校验、归一化、新鲜快照与故障降级。
- `bsc-signal-detection`: 通过 Bonding Curve、排名动量和跨来源确认路径筛选候选，执行安全硬拒绝、发送前回落检查、追高提示与噪音控制。
- `telegram-signal-delivery`: 以持久化去重和模糊结果失败关闭方式发送简洁信号卡片、编辑双榜确认状态，并提供用户查询命令和 Telegram 失败处理。
- `signal-outcomes-and-stats`: 采集信号后行情结果，按固定口径计算命中率、收益、MFE/MAE、覆盖率、推送量和延迟统计。
- `deterministic-signal-replay`: 持久化变化事件、Security 完成顺序和配置版本，支持相同输入产生相同结果的离线回算与参数对比。

### Modified Capabilities

无。当前仓库没有既有业务能力规范。

## Impact

- 新增 Node.js 22 + TypeScript strict 应用及配置、测试和运行脚本。
- 新增 GMGN OpenAPI 直接 HTTP 集成；生产环境需要 `GMGN_API_KEY`，但不需要交易私钥或签名。
- 新增 Telegram Bot 集成；运行环境需要 Telegram Bot Token 和目标 Chat ID。
- 新增本地 SQLite 数据库，使用 WAL、保留策略、5 GB 软上限和增量回收。
- 新增 Zod、grammY、better-sqlite3、Pino 等运行时依赖。
- 外部影响限于只读 GMGN 请求和 Telegram 消息发送；不会提交交易或写入链上状态。
