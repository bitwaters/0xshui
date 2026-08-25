# GMGN BSC Telegram 信号机器人 V1 开发方案

> 文档版本：V1.4<br>
> 更新日期：2026-08-24<br>
> 项目阶段：方案确认 / 待实施

## 1. 项目概述

本项目构建一个仅面向 BNB Smart Chain（BSC）的 Telegram 代币信号机器人。

V1 只负责发现、筛选、推送、结果统计和历史回算，不接入自动交易。后续系统稳定后，可以在相同信号事件上扩展 GMGN 交易接口，但交易功能不进入本阶段范围。

### 1.1 核心目标

- 使用 GMGN 已聚合的 1m/5m 热门榜，不自行重建复杂热门评分。
- 使用 GMGN Trenches 覆盖 Bonding Curve 极早期、临近毕业和已毕业代币。
- 在 GMGN 数据可见后，尽可能在数秒内完成筛选和 Telegram 推送。
- 候选池保持宽，Telegram 出口保持窄，控制信号噪音。
- 保存必要历史数据，支持后续修改参数并重新回算。
- 提供简洁的用户信号卡片和统计卡片。
- 保持单进程、单数据库、单数据供应商，降低维护成本。

### 1.2 V1 不做的功能

- 不支持 Solana 或其他链。
- 不接入自动买入、卖出、止盈止损。
- 不使用 Bitquery、GoPlus 或其他外部数据源。
- 不实现 AI 选币或复杂综合评分。
- 不使用 Market Signal、Hot Search、钱包跟踪作为实时主链路。
- 不做全量持币地址、交易者明细扫描。
- 不建设微服务、Redis、Kafka 或自建链上索引。
- 生产运行时不通过子进程反复执行 `gmgn-cli`，不抓取 GMGN 网页内部接口。

## 2. 核心设计原则

1. **GMGN 热榜判断热度**：本地不重新计算热门评分。
2. **Trenches 补充极早机会**：覆盖热榜形成前的 Bonding Curve 阶段。
3. **规则使用布尔条件**：只做硬拒绝、动量判断、交叉确认，不输出分数。
4. **首次信号优先速度**：不等待 5m 双榜确认才首次推送。
5. **双榜负责后续确认**：确认时优先编辑原 Telegram 消息，不重复刷屏。
6. **实时与离线分离**：回算、Kline、统计不进入实时关键路径。
7. **未知不等于安全**：关键安全字段缺失时不生成正式信号。

## 3. 系统架构

```text
                  GMGN OpenAPI（直接 HTTP）
                                │
                 统一调度器（每秒一个基础请求）
                                │
                 ┌──────────────┼──────────────┐
                 ↓              ↓              ↓
             Trenches       1m Top100      5m Top100
          三阶段请求上限 80
                 └──────────────┼──────────────┘
                                ↓
                     地址标准化、合并、去重
                                ↓
                        内存候选池（静默）
                                ↓
                    安全硬过滤 + 动量触发
                                ↓
                  Token Security 异步复查
                                ↓
                       发送前最新状态检查
                                ↓
                         Telegram 信号

        ┌───────────────────────┴───────────────────────┐
        ↓                                               ↓
  SQLite 快照/信号                                  异步结果采集
        ↓                                               ↓
   参数回算工具                                  Kline / 结果统计
```

### 3.1 部署形态

V1 使用一个后台服务，内部模块如下：

```text
GmgnHttpClient（直接 OpenAPI）
Unified Scheduler
Candidate Merger
Snapshot Store
Signal Detector
Security Verifier
Telegram Publisher
Outcome Collector
Replay Engine
Stats Aggregator
SQLite Repository
```

所有模块运行在同一个进程中。只有 SQLite 持久化数据，短期候选窗口和 Security 缓存保存在内存中。

`GMGN_API_KEY` 与 Telegram Bot Token 只通过部署环境或 Secret 文件注入，不写入 YAML、SQLite、日志或仓库。启动时缺少凭据直接失败，不进入半工作状态。

### 3.2 固定技术栈与 GMGN 接入方式

V1 固定使用：

```text
Runtime          Node.js 22
Language         TypeScript（strict）
GMGN Transport   Node 原生 fetch / Undici，直接请求官方 OpenAPI
Schema           Zod，仅校验项目实际使用的响应字段
Telegram         grammY
Database         better-sqlite3 + SQLite WAL
Logging          Pino 结构化日志
```

生产主链路只使用项目内的单例 `GmgnHttpClient` 直接访问 `https://openapi.gmgn.ai`。`gmgn-cli` 只用于开发期人工查询、Schema 抽样和故障诊断；不得在每秒轮询中启动 CLI 子进程，也不得从 `gmgn-cli/dist/...` 深层导入未承诺稳定的内部模块。

`GmgnHttpClient` 只暴露 `fetchTrenches()`、`fetchRank()`、`fetchSecurity()`、`fetchKline()`、`fetchPool()` 五个方法，仅负责鉴权、HTTP、限流错误和响应解包；字段归一化放在独立 Adapter，业务规则不得进入 HTTP Client。

## 4. GMGN 接口使用范围

### 4.0 直接 OpenAPI 约定

固定基础地址：

```text
https://openapi.gmgn.ai
```

V1 的 Market、Trenches、Token Security、Kline 和 Token Pool 都是只读接口，统一使用 Exist Auth：

```text
Header: X-APIKEY = ${GMGN_API_KEY}
Query:  timestamp = 当前 Unix 秒
Query:  client_id = 每次请求新生成的 UUID
Header: User-Agent = gmgn-bsc-signal-bot/<version>
Header: Content-Type = application/json
```

`timestamp` 必须来自已同步的系统时钟；启动时若系统时间明显异常则拒绝运行。每次重试必须重新生成 `timestamp` 和 `client_id`。V1 不读取、不配置 `GMGN_PRIVATE_KEY`，也不实现 `X-Signature`；这些只在后续接入 Swap/Order 时进入独立交易客户端。

直接 API 当前实测存在双层包装，适配层只允许以下两种已验证结构：

```text
单层：{ code: 0, data: <业务数据> }
双层：{ code: 0, data: { code: 0, data: <业务数据>, ... } }
```

最多显式解包两层；每层都必须验证 `code = 0`。不递归猜测、不把业务对象中偶然出现的 `data` 字段继续解包。未知包装结构触发 `schema_contract_failed` 并停止正式推送。

### 4.1 Trenches

用途：发现 Launchpad 新币及生命周期阶段。

一次请求包含：

```text
new_creation
near_completion
completed
```

配置：

```text
POST /v1/trenches
chain = bsc
limit = 80（请求允许的每阶段最大值）
filter_preset = safe
```

按接口文档配置的理论上限：

```text
80 × 3 = 240 条
```

但不能把 240 当成固定返回量。2026-08-24 使用 `gmgn-cli 1.5.6` 对 BSC 实测时，`limit=3` 和 `limit=80` 都返回每阶段 60 条，说明当前上游实际条数可能由服务端固定。系统仍请求最大值 80，同时记录每轮三个数组的实际长度。

若未来上游异常返回超过 80 条，适配层每阶段只接收前 80 条并报警，避免响应失控拖慢实时链路。

响应适配层同时接受当前 CLI 实测键 `near_completion` 和官方文档中的旧键 `data.pump`，统一映射为内部阶段 `near_completion`；业务层不直接依赖上游响应键名。

请求参数由项目内 `GmgnHttpClient.fetchTrenches()` 序列化；业务层只依赖归一化后的接口，不直接拼 URL 或读取上游原始 JSON，避免上游变化扩散到 Detector。

### 4.2 1m 聚合热榜

用途：首次热榜信号、排名速度、快速突破。

```text
GET /v1/market/rank
chain = bsc
interval = 1m
limit = 100
order_by = default
direction = desc
filters = [not_honeypot, verified, renounced]
```

### 4.3 5m 聚合热榜

用途：确认热度持续，不阻塞首次信号。

```text
GET /v1/market/rank
chain = bsc
interval = 5m
limit = 100
order_by = default
direction = desc
filters = [not_honeypot, verified, renounced]
```

### 4.4 Token Security

用途：候选币推送前复查安全字段。

```text
GET /v1/token/security
chain = bsc
address = token_address
```

只查询接近触发条件的候选币，不全市场扫描。

### 4.5 Kline（仅离线）

用途：信号结果统计、MFE/MAE 和参数回算，不参与实时判断。

```text
GET /v1/market/token_kline
resolution = 30s
from = signal_sent_at
to = signal_sent_at + 1h
```

### 4.6 Token Pool（仅离线辅助）

用途：已毕业信号发送后异步保存池基线；Kline 为空时辅助区分无交易、撤池与 API 缺失。

```text
GET /v1/token/pool_info
chain = bsc
address = token_address
```

该接口不阻塞 Telegram，不参与触发，只在已毕业信号基线和异常结果判定时调用。

### 4.7 采集边界

V1 为保持简单和控制风险，保留 GMGN 服务端安全过滤：

```text
Trenches：filter_preset = safe
Rank：显式 filters = [not_honeypot, verified, renounced]
```

因此历史回算只覆盖“GMGN 上游安全过滤后的候选集合”，可以优化本地动量、排名、噪音和更严格的安全阈值，但不能评估被上游过滤掉的代币，也不能回算比上游 Safe 更宽松的安全条件。每条快照必须记录 `upstream_filter_version`，避免 GMGN 默认过滤规则变化后混合比较。

### 4.8 已验证的 BSC Schema 基线

2026-08-24 使用 `gmgn-cli 1.5.6` 和直接 OpenAPI 对公开 BSC 数据进行了只读抽样。实现以实际响应为准，并把以下结果写成适配层契约测试：

```text
Rank：buys / sells / swaps 是所请求 1m 或 5m 窗口数据
Trenches：progress、swaps_24h、net_buy_24h、holder_count 可用
Trenches：抽样三阶段均未返回 swaps_1m，因此曲线动量必须用累计值差分
Security：稳定返回 Honeypot、开源、Owner、税率、Top10 和 lock_summary
Security：can_sell 与 can_not_sell 可同时为 0，不能视为卖出模拟结果
Kline：time 为毫秒，OHLC/volume 为字符串
直接 Rank：HTTP 200，单次约 468～605ms，响应为已验证的双层包装
```

启动时执行一次轻量 Schema 自检。已知类型差异由适配层显式归一化；必需字段出现未知结构时停止正式推送并报警，不能静默猜字段。

## 5. 轮询、限速与并发

### 5.1 统一轮询

统一调度器仍只配置一个 `poll_interval: 1s`，按固定四拍轮转：

```text
Trenches → 1m Rank → Trenches → 5m Rank → 重复
```

每个 Tick 最多发起一个基础请求，因此 Trenches 每 2 秒更新，1m/5m Rank 各每 4 秒更新。每个来源各自只有一个在途请求；上一轮未结束时只跳过该来源排定的 Tick。仍然只有一个调度器和一份配置，不增加三个独立周期。

### 5.2 权重预算

```text
Trenches       weight 3 / 2秒
1m Rank        weight 1 / 4秒
5m Rank        weight 1 / 4秒
-----------------------------
基础平均负载    1 request/秒，weight 2/秒
```

本地统一限速设置为：

```text
4 weight/秒
```

剩余容量用于 Token Security 和低频结果采集。Security 最大并发为 3，但所有请求仍受同一限速器和 429 全局冷却控制。

### 5.3 HTTP Client 约束

- 全进程只创建一个 `GmgnHttpClient`，复用 Node/Undici 连接池，不为每次请求创建进程或新客户端。
- 单请求硬超时 5 秒；超时后释放该来源在途标记，由下一轮调度恢复。
- 网络错误或 5xx 最多快速重试 1 次，使用 200～500ms 抖动；重试时生成新的 `timestamp/client_id`。
- 429 不进入普通重试，统一交给全局冷却逻辑。
- 只接受 JSON；单响应体上限 10MB，超限按 Schema 错误处理。
- HTTP 层返回 `unknown`，只有 Zod 适配成功后才能进入候选池。

### 5.4 429 处理

- 收到 429 后暂停全部 GMGN 请求，而不是只暂停当前接口。
- 优先采用合法的未来 `X-RateLimit-Reset`，其次采用响应中的合法未来 `reset_at`；两者缺失或非法时默认冷却 5 分钟。
- 有效 reset 时间额外增加 1 秒安全缓冲；将 `cooldown_until` 保存到 `runtime_state`，服务重启后继续遵守未结束的冷却。
- 冷却期间不发起任何 GMGN 请求。
- 冷却结束后逐步恢复，先恢复榜单，再恢复 Security 和离线任务。
- 离线 Kline 和结果采集在限流压力下可以延迟，不影响实时榜单。

## 6. 数据标准化

GMGN 不同接口字段名称可能不同，进入业务层前统一为内部模型：

```text
token_address
token_key
creator_address
stage
launchpad_platform
price
market_cap
liquidity
rank_1m
rank_5m
swaps_1m
buy_count_1m
sell_count_1m
holder_count
curve_swaps_total
curve_net_buy_total
bonding_progress
smart_degen_count
security_fields
source_flags
event_type
source
ingest_seq
sampling_level
upstream_filter_version
adapter_version
captured_at
```

其中：

```text
source_flags.trenches_new
source_flags.trenches_near
source_flags.trenches_completed
source_flags.rank_1m
source_flags.rank_5m
```

`token_address` 必须先通过 BSC 地址校验 `^0x[0-9a-fA-F]{40}$`；`token_key` 统一使用小写地址做去重和数据库唯一键，展示时可保留校验和格式。排名未进入 Top100 时按 101 参与内部排名变化计算，但用户卡片显示“未进入”。

`captured_at` 是 Bot 本地收到并提交该来源响应的 UTC 时间，不使用代币创建时间或 Kline 时间代替；来源新鲜度和延迟统计都以它为准。

`curve_swaps_total` 和 `curve_net_buy_total` 分别映射 Trenches 的 `swaps_24h` 与 `net_buy_24h`。对新币而言它们接近“创建以来累计值”，曲线动量使用两个快照的差值；热榜不伪造净买入金额，直接使用 Rank 提供的窗口买卖笔数。

### 6.1 字段来源契约

实现前必须按照下表固定字段来源，不允许根据名称猜测或跨接口混用：

| 内部字段 | 首选来源 | 原始字段/计算 | 缺失处理 |
|---|---|---|---|
| `rank_1m/rank_5m` | Market Rank | `rank` | 写入退出快照并设为 `null` |
| `buy_count_1m` | 1m Rank | `buys` | 热榜路径不触发 |
| `sell_count_1m` | 1m Rank | `sells` | 热榜路径不触发 |
| `curve_swaps_total` | Trenches | `swaps_24h` | 曲线路径不触发 |
| `curve_net_buy_total` | Trenches | `net_buy_24h` | 曲线路径不触发 |
| `bonding_progress` | Trenches | 当前实测 `progress`；兼容已知旧字段 `launchpad_progress` | 曲线路径不触发 |
| `lock_percent` | Rank | `lock_percent` | 再读取 Security 的 `lock_summary.lock_detail[].percent`；仍缺失则已毕业正式信号不触发 |
| `burn_status` | Rank/Trenches | `burn_status` | 只有官方明确值 `burn` 单独证明已销毁；实测值 `yes` 仅保留，不单独放行 |
| Honeypot/税率/Open Source/Owner | Token Security | 兼容布尔、0/1、yes/no 三种已知返回类型 | 正式信号不触发；曲线 Owner 例外见 9.3 |
| `top_10_holder_rate` | Token Security，榜单回退 | Security 同名字段 | 正式信号不触发 |
| Dev/Creator/Bundler/Insider/Rat | Trenches 或 Rank | `dev_team_hold_rate`、`creator_balance_rate`、`bundler_rate/bundler_trader_amount_rate`、`suspected_insider_hold_rate`、`rat_trader_amount_rate` | 有值时执行本地硬拒绝；Trenches 的 Rug/Bundler/Insider 同时受 Safe 上游过滤保护 |
| Rug/Wash | Rank/Trenches | `rug_ratio`、`is_wash_trading` | 有值时执行硬拒绝；不得假设 Security 一定补齐 |
| `entrapment_ratio` | Rank/Trenches | `entrapment_ratio` | 缺失则只跳过该项 |

所有比例和税率先转为有限数值并校验在 `0～1` 范围；非法值按缺失处理。空字符串只有在对应官方字段契约明确表示 0 时才转为 0，否则按未知处理。布尔值只接受已列出的 `true/false`、`1/0`、`yes/no`，不使用 JavaScript 真值转换，避免字符串 `"0"` 被误判为 true。

V1 不实现独立卖出模拟。“可以卖出”只采用以下可验证代理条件，不宣称绝对可卖：

```text
is_honeypot = false
AND sell_tax <= 10%
```

`can_sell` 和 `can_not_sell` 不参与判断；实测两者可同时为 0，无法证明已经做过成功卖出模拟。

Creator 历史创建数量虽已在本次 Trenches 抽样中出现，但没有经过历史回算验证阈值。V1 不据此新增硬规则，仅保存原值供后续分析，继续使用 Creator 持仓过滤和 Creator 推送冷却。

## 7. 启动基线与新鲜快照

### 7.1 启动保护

服务启动时为 Trenches、1m Rank 和 5m Rank 分别用首次成功响应建立基线；尚未建立基线的来源不参与检测，但不阻塞其他来源的独立路径：

- 不推送启动前已经存在的代币。
- 只处理启动后的新上榜、排名明显变化或曲线加速。
- 防止服务重启后把 Top100 全量重复推送。

### 7.2 新鲜快照定义

只有以下字段任意变化，才记录为新鲜快照：

```text
rank_1m
rank_5m
swaps_1m
buy_count_1m
sell_count_1m
holder_count
curve_swaps_total
curve_net_buy_total
bonding_progress
market_cap
smart_degen_count
```

相同 API 响应重复出现不算连续确认。

每个来源成功返回并通过 Schema 校验后，与该来源上一份成功结果做一次差分：

```text
新出现       → event_type = enter
字段变化     → event_type = update
上一轮存在、本轮缺失 → event_type = exit，rank 写为 null
```

一次来源提交先完成全部 enter/update/exit，再原子更新内存状态并运行一次 Detector。每次来源提交或 Security 完成事件都分配严格递增的 `ingest_seq`；实时环境按该顺序处理，回放也按该顺序重放，避免用人为固定来源顺序模拟异步响应。

这样实时逻辑和历史回放都能识别掉榜，不需要新增复杂事件系统。内存中每个代币保留最近 60 秒、最多 10 个新鲜快照。SQLite 只持久化 `enter/update/exit` 快照，不写入重复数据。同一来源一次响应内的多个字段变化只算一个新鲜快照。

请求失败、超时或 Schema 错误绝不能生成 `exit`。跨来源条件只使用最近 10 秒内成功收到的数据；更旧的 Trenches/1m/5m 状态可以留作展示，但不能参与首次触发或双榜确认。

## 8. 候选池与 Security 预热

榜单和 Trenches 返回结果只代表候选，不等于 Telegram 信号。

### 8.1 热榜预热条件

```text
进入 1m Top30
```

### 8.2 曲线预热条件

```text
curve_swaps_total >= 10
holder_count >= 10
curve_net_buy_total > 0
```

满足预热条件后立即异步查询 Token Security，同时继续收集动量快照。Security 成功结果可缓存 60 秒用于候选预筛；失败的非紧急预热也在内存抑制 60 秒，避免对同一不完整代币反复消耗额度。正式发送时检查结果年龄不得超过 10 秒；超过 10 秒或此前预热失败时，紧急刷新不受失败抑制。

服务冷启动时不批量预热已有 Top30，只有出现新变化或新候选时才进入预热队列，避免启动瞬间冲击限流。Top30 已覆盖两条热榜首次触发路径，继续预热 Top31～50 只会增加 Security 队列和延迟。

## 9. 安全硬过滤

V1 不输出综合安全分。任何硬拒绝条件命中即不推送。

### 9.1 通用硬拒绝

```text
is_honeypot = yes
is_wash_trading = true

rug_ratio > 0.30
bundler_rate > 0.30
insider_ratio > 0.30
rat_trader_rate > 0.30
entrapment_ratio > 0.30

dev_team_hold_rate > 0.15
creator_balance_rate > 0.15
top_10_holder_rate > 0.50
```

上面使用的是内部归一化名称；例如 `bundler_rate` 可来自 `bundler_rate` 或 `bundler_trader_amount_rate`，`insider_ratio` 可来自 `suspected_insider_hold_rate`。适配只允许字段来源契约中列出的别名。

字段缺失策略按来源处理，避免“全部放行”和“永远零信号”两个极端：

```text
Security 必需：Honeypot、Open Source、税率、Top10
已毕业额外必需：Owner Renounced、LP 已锁或已销毁
曲线必需：Trenches Safe 请求成功、Bundler/Insider/Dev/Creator 持仓字段可用
可选增强：Rug、Wash、Rat、Entrapment；有值就硬拒绝，缺失就记录 unknown
```

`filter_preset=safe` 官方定义只保证上游执行 Rug、Bundler、Insider 三项阈值，并不等价于完整安全审计。Wash 等可选字段缺失时，卡片仍只能写“GMGN 风险筛选通过”，不能写“安全”。Rank/Trenches 与 Security 同一字段冲突时采用更危险值，并记录 `security_conflict`。

V1 不使用尚未完成历史回算校准的 Creator 创建数量做硬过滤。Creator 风险只使用 `creator_balance_rate`、`dev_team_hold_rate` 和 Creator 推送冷却。

### 9.2 已毕业和 DEX 代币附加条件

```text
open_source = yes
owner_renounced = yes
buy_tax <= 10%
sell_tax <= 10%
is_honeypot = false
lp_burned = true OR lock_percent >= 0.50
```

`lp_burned=true` 只在 `burn_status=burn` 时成立。当前实测出现的 `burn_status=yes` 含义不够明确，不能单独放行。`lock_percent` 优先使用 Rank，缺失时使用 Security `lock_summary` 中最大的明细比例。仅有 `lock_summary.is_locked=true`、但没有可解析比例时仍视为未知。如果 LP 或关键合约字段未知，不能生成正式已毕业信号。

### 9.3 Bonding Curve 特殊规则

曲线阶段不检查以下 DEX 条件：

```text
DEX Liquidity
DEX LP
LP Lock
LP Burn
DEX卖出次数
```

允许以下字段暂时未知：

```text
owner_renounced
LP状态
DEX流动性
```

以下关键字段未知时暂不推送，继续留在候选池等待数据补齐：

```text
Honeypot
Bundler
Insider
Dev/Creator持仓
```

Rug 与 Wash 字段若存在则继续执行硬拒绝；若 Trenches Safe 请求成功但响应未携带它们，记录为 `unknown`，不额外阻断曲线信号。原因是本次 BSC 实测中大多数 Trenches 项没有返回这两个字段，而 Token Security 也未补齐；若把它们设为必需，曲线路径会错误地接近零信号。

## 10. 首次信号触发规则

所有规则均为布尔条件，不计算总分。

### 10.1 路径 A：Bonding Curve 加速

适用于 `new_creation` 和 `near_completion`。

基础门槛：

```text
curve_swaps_total >= 20
holder_count >= 20
curve_net_buy_total > 0
```

最近 15 秒同时满足：

```text
bonding_progress 增加 >= 2 个百分点
holder_count 增加 >= 3
curve_net_buy_total 增加 > 0
```

再满足任意一项：

```text
curve_swaps_total 增加 >= 10
OR smart_degen_count >= 1
```

最终逻辑：

```text
GMGN风险过滤通过
AND 交易达到最低门槛
AND 曲线正在前进且累计净买入仍在增加
AND Holder 正在增长
AND（交易加速 OR Smart Money 出现）
```

15 秒差分只比较同一代币的 Trenches 新鲜快照，至少需要 2 个快照。若累计字段下降，视为上游重算或数据异常，重置该字段基线，本轮不触发；不把负差值解释为卖出。

### 10.2 路径 B：1m 极速突破

最近 10 秒满足：

```text
当前 rank_1m <= 10
rank_1m 提升 >= 15 位
buy_count_1m > sell_count_1m
至少 2 个 1m Rank 新鲜快照
```

再满足任意一项：

```text
holder_count 增加 >= 3
OR 同时出现在 Trenches
OR smart_degen_count 增加
```

### 10.3 路径 C：跨来源启动

```text
当前 rank_1m <= 30
rank_1m 提升 >= 10 位
buy_count_1m > sell_count_1m
```

并且满足任意一个来源确认：

```text
同时出现在 Trenches
OR 当前 rank_5m <= 80
```

再满足真实参与变化：

```text
holder_count 增加 >= 3
OR swaps_1m 增加 >= 10
```

## 11. 发送前回落检查

Token Security 完成后，使用最新一轮快照进行最终检查。若 Security 距当前超过 10 秒，先刷新 Security，并在等待期间继续执行排名回落检查。以下任意一项命中则取消：

```text
热榜币 rank_1m 相比期间最佳排名回落 >= 15 位
热榜币连续 2 个 Rank 新鲜快照离开 1m Top100
热榜币 buy_count_1m <= sell_count_1m
热榜币 swaps_1m 相比候选时下降 >= 40%
Security 状态恶化
is_wash_trading 变为 true
```

曲线币额外取消：

```text
bonding_progress 停止增长
AND holder_count 也停止增长
AND curve_net_buy_total 没有增加
```

被取消的候选仍写入内部日志，供后续回算判断取消规则是否过严。

## 12. 双榜确认

双榜确认不是首次信号门槛，而是首次信号后的质量确认。

条件：

```text
当前 rank_1m <= 30
当前 rank_5m <= 50
至少连续 2 次 Rank 来源更新时都位于双榜
buy_count_1m > sell_count_1m
```

相比首次信号：

```text
rank_1m 继续提升 >= 5 位
rank_5m 相比首次进入继续提升 >= 3 位
```

同时要求：

```text
holder_count 仍在增长
OR swaps_1m 仍在增长
```

确认成功后默认编辑原 Telegram 消息，将 `⚡` 更新为 `🔥`，不发送第二条消息。没有首次信号但直接满足双榜确认时，可以直接创建一条双榜信号。

## 13. 极速波动与追高提示

V1 不因为短时涨幅超过 100% 就完全静默，因为 BSC 热门币可能在几分钟内上涨数倍。

系统保存：

```text
first_seen_price
first_seen_market_cap
qualified_price
sent_price
```

### 13.1 热榜代币

```text
发现到发送涨幅 < 30%    → 正常信号
30%～100%               → 快速拉升警告
> 100%                  → 极端波动，只标记为观察型信号
```

### 13.2 曲线代币

```text
当前市值 / 首次发现市值 < 1.5    → 正常信号
1.5～<2.0                          → 快速拉升警告
>= 2.0                             → 极端波动，只标记为观察型信号
```

观察型信号仍可推送，但必须明确当前价格已经偏离系统首次发现价格，不能显示成普通信号。

## 14. 噪音控制

### 14.1 单代币去重

- 每个代币生命周期只创建一条 Telegram 消息。
- 后续双榜确认通过编辑原消息更新。
- 服务重启后从 SQLite 恢复 `telegram_message_id` 和已推送状态。

### 14.2 创建者限频

```text
同一 creator_address 30 分钟最多产生 1 条首次信号
```

仅当 `creator_address` 是合法的非空 BSC 地址时执行该限频；未知 Creator 不能共用一个空值键，否则会误伤所有 Creator 缺失的代币。

### 14.3 全局信号限频

初始配置：

```text
每分钟最多 3 条首次信号
其中普通信号最多 2 条，至少为高优先级保留 1 个位置
```

高优先级只包括：

```text
尚未发过首次消息、但直接满足双榜确认
OR 1m 榜 + Trenches 重合
```

实现使用一个 60 秒滚动窗口：总数达到 3 后全部抑制；普通信号达到 2 后，只允许高优先级使用剩余位置。固定优先级只用于同一次来源提交中同时触发的候选，不等待未来信号，也不延迟秒级推送。已有消息的双榜确认编辑不计入限额。因全局限频被抑制的候选必须写入数据库，便于回算判断该限制是否导致漏掉高质量信号。

## 15. 延迟预算

需要区分：

```text
链上变化 → GMGN 数据可见
GMGN 数据可见 → Bot 推送
```

GMGN 没有公开市场榜单更新 SLA，因此 V1 只对第二段设置验收目标。

### 15.1 Bot 可控延迟

| 环节 | 预计耗时 |
|---|---:|
| Trenches 轮询等待 | 0～2 秒，平均约 1 秒 |
| 1m/5m Rank 轮询等待 | 0～4 秒，平均约 2 秒 |
| 合并与规则计算 | 通常低于 50 毫秒 |
| Security 已预热 | 0～0.2 秒 |
| Security 未预热 | 暂按约 1～4 秒预算 |
| 最终状态复查 | 0～1 秒 |
| Telegram API | 暂按约 0.2～1.5 秒预算 |

2026-08-24 直接 OpenAPI 的 BSC Rank 抽样约为 468～605ms；相同环境通过 CLI 的暖请求约为 Rank 2.6 秒、Trenches 3.2～3.9 秒、Security 3.0 秒，首次冷 Rank 约 8.9 秒。CLI 数字包含子进程启动，证明它不适合作为生产轮询链路。以上都只是小样本而非 GMGN SLA；影子运行必须分别统计直接 API 的 Rank、Trenches 和 Security P50/P95。

### 15.2 各信号预计延迟

从 GMGN 第一次返回候选开始：

| 信号方式 | 预计首次推送 |
|---|---:|
| 1m 极速突破 | 约 4～12 秒 |
| 跨来源启动 | 约 4～14 秒 |
| Bonding Curve 加速 | 约 4～20 秒 |
| 双榜确认 | 首次信号后约 5～30 秒 |

曲线时间包含市场形成 Progress、Holder、Trades 变化所需的观察时间，不全部属于系统处理延迟。

### 15.3 时间戳记录

每个信号记录：

```text
first_seen_at
security_started_at
security_completed_at
qualified_at
final_checked_at
telegram_requested_at
telegram_sent_at
```

验收目标：

```text
首个包含候选的 GMGN 响应接收 → 候选入池：P95 < 0.2 秒
条件满足 → Telegram 完成：影子期目标 P95 < 5 秒
1m 极速信号总延迟：影子期目标 P50 < 5 秒，P95 < 10 秒
```

前两项是 Bot 目标，不承诺链上事件到 GMGN 可见的时间。延迟样本达到 30 个后用实测 P50/P95 替换估算；若 P95 不达标，先检查 Security 队列和 GMGN 响应时间，不通过缩短轮询间隔掩盖上游延迟。

## 16. 用户信号卡片

用户卡片只显示决策所需信息，不展示内部阈值、公式、缓存、快照数量和 API 权重。

### 16.1 Bonding Curve 卡片

```text
⚡ BSC 动量信号

TOKEN · $TOKEN
阶段：Bonding Curve
风险：极高

价格：$0.000016
市值：$160K
曲线进度：37%

1m热榜：#8 ↑
5m热榜：未进入
持币地址：41
累计净买入：$4.8K

GMGN风险筛选：✅ 已通过
发现后变化：+33%
推送延迟：3.1秒

CA：0x1234...abcd

[GMGN] [BscScan] [复制合约]
```

### 16.2 已毕业双榜卡片

```text
🔥 BSC 双榜信号

TOKEN · $TOKEN
阶段：已毕业
风险：高

价格：$0.000031
市值：$310K
流动性：$52K

1m热榜：#6 ↑
5m热榜：#28 ↑
持币地址：186
买/卖笔数：35 / 21

GMGN风险筛选：✅ 已通过
发现后变化：+21%
推送延迟：4.2秒

CA：0x1234...abcd

[GMGN] [BscScan] [复制合约]
```

### 16.3 仅在异常时增加的提示

```text
⚠️ 发现后已快速上涨 86%
⚠️ 当前波动极大
⚠️ 部分曲线阶段字段暂不可用
```

用户卡片不显示：

```text
安全阈值
触发公式
新鲜快照数量
Security缓存状态
内部评分
API响应体
```

### 16.4 Telegram 内容安全与按钮

代币名称、Symbol、Logo 和社交字段都属于攻击者可控数据。发送前必须：

- 对名称和 Symbol 做长度限制、移除控制字符，并按选定的 Telegram `parse_mode` 完整转义。
- V1 不加载或发送项目方 Logo，不展示原始项目网站、X 或 Telegram 链接。
- 不读取或执行代币描述中的任何指令，不自动打开项目方网站或社交链接。
- GMGN 和 BscScan 按钮只能用通过 BSC 地址校验的合约地址拼接固定模板：`https://gmgn.ai/bsc/token/{address}` 与 `https://bscscan.com/token/{address}`。
- “复制合约”使用 Telegram Bot API 的 `InlineKeyboardButton.copy_text`，复制内容只允许是已验证合约地址。
- API Key、原始响应和异常堆栈不得进入用户消息；日志中的密钥和 Telegram Token 必须脱敏。

卡片底部固定附一行短提示：

```text
仅为数据筛选信号，不代表安全或可成交收益。
```

## 17. 结果采集与统计口径

### 17.1 信号后结果采集

每条信号只做两次离线评估：

```text
T+15m
T+1h
```

T+15m 拉取一次从发送时刻开始的 30 秒 Kline，计算 1m/5m/15m 收益与 15m MFE/MAE；T+1h 再拉取一次补齐 1h 收益、1h MFE/MAE、目标倍数是否触达及首次 2x 用时。两次离线请求同时满足早期诊断和完整观察窗口统计，不为每条信号增加持续行情请求。

最终保存：

```text
return_1m
return_5m
return_15m
return_1h
max_gain_15m
max_gain_1h
max_drawdown_15m
max_drawdown_1h
time_to_2x_ms
```

收益基准统一使用 `sent_price`，即发送前最终快照价格，而不是首次发现价格。

已毕业信号发送后异步调用一次 `token pool` 保存池地址和流动性；不等待该请求完成才发送 Telegram。它只为后续识别撤池提供基线，不参与实时触发。

15 分钟和 1 小时两个观察周期各自必须进入以下终态之一，不能无限停留在“待评估”：

```text
complete        正常取得结果
no_trade        观察期内没有后续交易
pool_removed    池子消失或无法继续交易
api_missing     GMGN数据暂时缺失
retry_exhausted API重试耗尽
```

处理规则保持简单：

```text
no_trade
→ 按未命中计入命中率；收益记为 0%，因为“没有后续成交”不等于本金归零

pool_removed
→ 按失败计入命中率；保守收益记为 -100%

api_missing / retry_exhausted
→ 标记为数据未知，不进入命中率，但必须计入数据覆盖率
```

`no_trade` 不能只凭空 Kline 猜测：Kline 必须成功返回有效空数据；已毕业代币还要由 Pool 复查确认有效流动性仍存在，曲线代币则要在检查点前后都有新鲜 Trenches 数据且累计 swaps 没有增加。证据不足时标记 `api_missing`。

不能仅凭 Kline 为空判断 `pool_removed`。只有系统曾成功记录过该代币的有效 DEX 池，低频 `token pool` 成功确认原池缺失或流动性为 0，同时没有可用替代池，才能标记撤池。已毕业信号在 T+1h 即使仍可读取历史 Kline，也复查一次发送时记录的 Pool：若代币此前达到 2x 后撤池，既保留 2x 命中，也计入已确认撤池。尚未毕业的曲线币没有 DEX 池属于正常状态，不能据此判撤池；Pool 请求报错不猜测撤池。该复查不进入实时路径。

每个观察检查点的结果查询最多重试 3 次，并在该检查点到期后的 10 分钟内完成终态判定。统计卡片必须显示 `已完成评估 / 应评估` 的数据覆盖率，避免缺失行情造成幸存者偏差。

30 秒 Kline 只使用开盘时间不早于 `ceil(sent_at / 30s) × 30s` 的蜡烛计算区间高低点；若 `sent_at` 恰好落在边界则保留该根。`sent_at` 到该边界之间只使用已保存的实时价格快照，避免把信号发送前的同一根蜡烛高低点计入结果。

每个 T 检查点价格取不晚于 `sent_at + T` 的最后一根已完成 30 秒蜡烛收盘价，收益为 `(price_T - sent_price) / sent_price`；MFE 使用区间最高价，MAE 使用区间最低价。不得读取检查点之后的蜡烛填补缺口。

### 17.2 倍数命中率定义

主要质量统计统一使用信号后的完整 1 小时观察窗口，`sent_price` 记为 `1.0x`：

```text
≥1.2x
≥1.5x
≥2x
≥3x
≥5x
```

只统计已经完成 1 小时观察周期且结果可确定的信号。代币即使活不过 15 分钟也不从分母排除：`no_trade` 和已确认 `pool_removed` 均按未命中计入；`api_missing/retry_exhausted` 不猜测结果，只降低覆盖率。尚未满 1 小时的信号显示为“待评估”。

只有状态为 `sent` 或 `confirmed` 的信号进入推送数量、命中率和收益统计；`delivery_unknown` 只进入运维失败指标。

### 17.3 MFE 与 MAE

```text
MFE：信号后最大有利波动
MAE：信号后最大不利波动
```

统计卡片必须同时展示涨幅和回撤，避免只显示最高涨幅造成结果过度乐观。

倍数命中率和 MFE 使用区间最高价，是“价格曾触达”的研究指标，不代表用户能以该价格成交；统计卡片必须保留这一说明。首次 2x 用时取首次实时价格触达时间，或首次触达该价格的 30 秒蜡烛结束时间，因此是保守近似。

## 18. Telegram 统计卡片

支持：

```text
/stats
/stats 7d
/stats 30d
/stats detail
```

默认 `/stats` 展示当前配置版本累计数据；日报使用配置的报告时区统计今日数据，数据库内部统一使用 UTC。

### 18.1 默认统计卡片

```text
📊 BSC 信号统计 · 当前版本累计

推送：18
倍数样本：12/14
待满观察窗口：4

≥1.2x：50%  6/12
≥1.5x：33%  4/12
≥2x：25%  3/12
≥3x：8%  1/12
≥5x：0%  0/12

最高倍数中位数：1.38x
达到2x中位用时：4分32秒
无交易率：17%  2/12
已确认撤池率：8%  1/12

曲线毕业率：33%
双榜确认率：33%
中位推送延迟：3.8秒
1h数据覆盖率：86%  12/14

口径：1小时内达到目标倍数即命中；早死、无交易和确认撤池计为失败
注：最高倍数和触达时间为价格研究指标，不代表实际可成交收益
```

### 18.2 详细统计

`/stats detail` 可按触发来源拆分：

```text
曲线加速
1m极速突破
跨来源启动
双榜确认
```

每类显示信号数、1.5x/2x 命中、最高倍数中位数、MAE 和平均延迟；固定时点 1m/5m/15m/1h 收益及 15m/1h MFE/MAE 也只在详细卡片展示。详细卡片用于调参，不主动每日推送。

曲线信号在 T+1h 前出现 GMGN `completed` 事件时记为已毕业；T+1h 时仍有新鲜 Trenches 数据且处于 `new_creation/near_completion` 时记为未毕业；其他情况记为毕业状态未知。曲线毕业率固定为 `已毕业 / (已毕业 + 未毕业)`，未知样本只降低覆盖率。双榜确认率固定为 `confirmed / (sent + confirmed)`，其中每条首次信号只计一次。

### 18.3 每日自动报告

- 每天按 `report_timezone` 推送一次。
- `runtime_state` 保存最后日报日期，服务重启后当天不重复发送。
- 如果当天没有完成评估的信号，显示“样本不足”，不计算误导性命中率。
- 默认显示中位数；平均值保留在详细统计中。

## 19. 历史回算与调参

### 19.1 回算目标

允许修改配置后回答：

```text
如果过去使用这组参数，会产生多少信号？
命中率是否提高？
是否漏掉已采集候选集合中的高倍币？
噪音和回撤是否下降？
延迟是否增加？
```

### 19.2 快照范围

保存：

```text
Trenches Safe 结果集的新鲜快照
已应用显式安全过滤的 1m Top100 新鲜快照
已应用显式安全过滤的 5m Top100 新鲜快照
候选Security结果
被过滤和被限频抑制的原因
```

为控制 SQLite 体积，采用两档持久化采样：

```text
高频候选：满足 Security 预热条件的代币
→ 保存每个 enter/update/exit 新鲜快照

普通榜单成员：尚未进入预热范围
→ enter/exit 必存，update 最多每 5 秒保存一次
```

内存实时检测使用每次成功返回的数据，不受持久化降采样影响。默认快照保留 14 天，`signals`、`signal_outcomes` 和配置版本保留 180 天。SQLite 设置 5 GB 软上限：先执行到期清理；仍超限时优先清理最旧普通榜单快照，再清理最旧辅助研究样本，不因容量压力删除真实信号及结果。因此原始快照和研究样本的实际可回算窗口受磁盘上限约束，真实推送质量统计继续累计。数据库初始化启用 WAL 和 `auto_vacuum=INCREMENTAL`；每日清理后执行 WAL checkpoint 与增量回收，避免“删了记录但文件仍持续膨胀”。

此外，对 Security 已通过且达到预热范围的候选保存紧凑研究样本：每个 `token/config_version` 最多一份，全局滚动 60 秒最多 5 份。样本保存当时最近市场窗口、Security、首次发现基线、基准价格及 Detector/Adapter/上游过滤版本，并复用低优先级结果任务采集 T+15m/T+1h。它们不发送 Telegram、不计入实际推送统计，只用于后续参数回算；实际信号的结果任务始终优先。

回算结论必须标注 `upstream_filter_version`、`adapter_version` 和 `sampling_level`，并明确结论只适用于被保存的上游结果集；普通榜单成员的历史回算时间精度为 5 秒。

### 19.3 重放规则

- 合并 `token_snapshots` 与 `security_checks`，按共享的严格递增 `ingest_seq` 播放，精确复现来源提交和 Security 完成顺序。
- 同一来源提交中的代币属于一个批次，批次内按 `token_key` 排序后统一评估优先级。
- 不用 `captured_at` 猜测同秒内的异步先后；它只用于窗口计算和展示。
- Detector 使用与实时环境相同的纯规则函数。
- 每次回算加载独立 `config_version`。
- 同时可对紧凑研究样本使用新配置重算，报告必须单独展示研究样本总数、被新参数选中的数量和质量，不能混入真实推送统计。
- `exit` 快照将对应排名清空为 `null`，内部判断时按 101 处理。
- 只能读取当前回放时刻及以前的数据，禁止未来数据泄漏。
- 同一配置、同一数据必须得到相同结果。

### 19.4 参数对比输出

```text
总候选数
总信号数
被安全过滤数
被动量过滤数
被回落取消数
被全局限频抑制数
1.2x/1.5x/2x/3x/5x命中率
最高倍数中位数
达到2x中位用时
无交易率/已确认撤池率
曲线毕业率
中位MFE
中位MAE
平均/中位推送延迟
```

## 20. 数据库设计

### 20.1 `token_snapshots`

```text
id
token_address
token_key
creator_address
captured_at
source
ingest_seq
event_type
sampling_level
upstream_filter_version
adapter_version
stage
launchpad_platform
source_flags_json
price
market_cap
liquidity
rank_1m
rank_5m
swaps_1m
buy_count_1m
sell_count_1m
holder_count
curve_swaps_total
curve_net_buy_total
bonding_progress
smart_degen_count
risk_summary_json
payload_hash
```

`risk_summary_json` 保存已经归一化的安全/风险值及字段来源，不依赖回放时重新解释旧原始 JSON。`payload_hash` 用于避免写入完全相同的重复快照。`ingest_seq` 按事件批次全局递增，同一来源批次中的多行共享该值；`token_key` 为小写 BSC 地址。两者分别保证确定性回放和地址去重。

### 20.2 `security_checks`

```text
id
token_address
token_key
ingest_seq
checked_at
expires_at
status
security_json
error_code
```

### 20.3 `signals`

```text
id
token_address
token_key
creator_address
signal_type
initial_signal_type
stage
config_version
first_seen_at
qualified_at
sent_at
first_seen_price
qualified_price
sent_price
first_seen_market_cap
sent_market_cap
pool_address_baseline
pool_liquidity_baseline
rank_1m_at_send
rank_5m_at_send
telegram_chat_id
telegram_message_id
confirmed_at
confirmation_rank_1m
confirmation_rank_5m
telegram_updated_at
status
suppression_reason
```

`initial_signal_type` 创建后不可修改，用于按首次触发来源统计；`signal_type` 表示当前卡片状态，可在双榜确认后更新。`confirmed_at` 和确认排名独立保存，避免编辑消息后丢失首次触发信息。

`signals.status` 使用固定枚举：

```text
rejected
cancelled
suppressed
delivery_pending
delivery_unknown
sent
confirmed
```

达到触发条件但因安全、回落或限频未发送的候选同样写入本表，`telegram_message_id` 为空，并记录 `suppression_reason`。这些未发送状态在后续新鲜事件中可以更新同一行并重新评估，但不会排队补发已经过时的旧条件；`delivery_pending`、`delivery_unknown`、`sent`、`confirmed` 不再执行首次发送。这样不增加额外事件表，也能支持回算过滤原因。

BSC V1 对 `signals.token_key` 建唯一约束；同一合约后续确认只更新原记录和原 Telegram 消息，不创建第二条生命周期记录。

### 20.4 `signal_outcomes`

```text
signal_id
status_15m
status_1h
price_1m
price_5m
price_15m
price_1h
return_1m
return_5m
return_15m
return_1h
max_gain_15m
max_gain_1h
max_drawdown_15m
max_drawdown_1h
graduated_at
evaluated_15m_at
evaluated_1h_at
```

15 分钟和 1 小时状态分别维护，避免 15 分钟已完成、1 小时仍待评估时被一个总状态覆盖。

### 20.5 `config_versions`

```text
version
created_at
config_json
upstream_filter_version
adapter_version
description
```

每条实时信号必须记录当时使用的配置版本。

### 20.6 `research_samples` 与 `research_outcomes`

`research_samples` 保存受限候选在采样时刻的完整规则输入和版本信息，按 `token_key + config_version` 去重；`research_outcomes` 保存相同的 15m/1h 结果状态。两表用于扩大可调参样本覆盖，但不会改变实时规则、TG 推送数或正式验收分母。

### 20.6 `runtime_state`

```text
key
value
```

只保存少量运行状态，例如 `next_ingest_seq`。快照提交和 Security 完成都在同一 SQLite 写事务中递增该值，保证跨表事件顺序可重放。

## 21. 配置建议

```yaml
chain: bsc
poll_interval: 1s
report_timezone: Asia/Shanghai

gmgn:
  transport: direct_http
  base_url: https://openapi.gmgn.ai
  user_agent: gmgn-bsc-signal-bot/1.0
  request_timeout: 5s
  network_retry: 1
  max_response_size: 10MB
  local_weight_limit_per_second: 4
  security_cache: 60s
  security_max_age_at_send: 10s
  security_max_concurrency: 3
  source_max_age_for_trigger: 10s

trenches:
  limit_per_stage: 80
  types:
    - new_creation
    - near_completion
    - completed
  filter_preset: safe

rank:
  limit: 100
  security_preheat_rank_1m: 30
  intervals:
    - 1m
    - 5m
  filters:
    - not_honeypot
    - verified
    - renounced

risk_filters:
  max_rug: 0.30
  max_bundler: 0.30
  max_insider: 0.30
  max_rat_trader: 0.30
  max_entrapment: 0.30
  max_dev_hold: 0.15
  max_creator_hold: 0.15
  max_top10: 0.50
  max_buy_tax: 0.10
  max_sell_tax: 0.10

curve_preheat:
  min_curve_swaps_total: 10
  min_holders: 10
  require_positive_curve_net_buy_total: true

curve_trigger:
  window: 15s
  min_curve_swaps_total: 20
  min_holders: 20
  min_progress_growth: 0.02
  min_holder_growth: 3
  min_curve_swap_growth: 10
  require_positive_curve_net_buy_growth: true

fast_rank_trigger:
  window: 10s
  max_rank_1m: 10
  min_rank_improvement: 15
  min_fresh_snapshots: 2

cross_source_trigger:
  max_rank_1m: 30
  min_rank_improvement: 10
  max_rank_5m: 80

confirmation:
  max_rank_1m: 30
  max_rank_5m: 50
  min_rank_1m_improvement: 5
  min_rank_5m_improvement: 3
  min_fresh_snapshots: 2

cancel:
  rank_fallback: 15
  swap_drop: 0.40
  missing_rank_snapshots: 2

noise:
  max_initial_signals_per_minute: 3
  max_normal_signals_per_minute: 2
  reserved_high_priority_slots: 1
  creator_cooldown: 30m
  one_message_per_token: true
  edit_message_on_confirmation: true

outcomes:
  checkpoints:
    - 15m
    - 1h
  # 以下旧字段保持 V1 值以延续现有 config_version 样本；主统计固定使用 1h 倍数口径
  hit_window: 15m
  hit_gain: 0.30
  large_gain_window: 1h
  large_gain: 1.00
  snapshot_retention: 14d
  signal_retention: 180d
  baseline_snapshot_interval: 5s
  sqlite_soft_limit: 5GB
  incremental_vacuum: true
```

## 22. 日志与可观测性

### 22.1 结构化日志事件

```text
poll_started
poll_completed
poll_skipped_overlap
schema_contract_failed
candidate_created
security_started
security_completed
security_failed
security_conflict
candidate_rejected
candidate_cancelled
signal_sent
signal_updated
signal_suppressed
outcome_collected
stats_generated
rate_limit_paused
rate_limit_resumed
```

### 22.2 核心指标

```text
GMGN请求成功率
GMGN请求P50/P95延迟
429次数与暂停时长
每轮候选数量
Security队列长度
每小时首次信号数量
各过滤原因数量
条件满足到TG发送P50/P95
Telegram发送失败率
结果采集完成率
快照写入数量
```

V1 不要求建设 Dashboard，结构化日志和 `/stats detail` 足够。后续有需要再接入监控系统。

## 23. 异常与降级策略

### 23.1 单个榜单失败

- 1m Rank 失败：不产生新的热榜首次信号。
- 5m Rank 失败：允许已满足 1m 极速条件的首次信号，暂停双榜确认。
- Trenches 失败：暂停曲线信号，热榜信号继续。
- Security 失败：不推正式信号。

### 23.2 数据陈旧

如果某个来源连续 10 秒没有成功返回，标记为陈旧：

- 不把重复响应视为持续动量。
- 响应成功但内容未变化只代表市场可能安静，不判定 API 故障。
- 记录告警日志。
- 不主动推送“接口异常”到用户信号频道。

### 23.3 Telegram 失败

- 调用 Telegram 前通过 SQLite 原子条件更新写入 `delivery_pending`，同一合约只有一个执行者可以进入发送。
- 只有能确认消息未被 Telegram 接受的错误才最多尝试 3 次并使用指数退避，例如连接建立前失败或明确的 429。
- 请求发出后的超时、连接中断或接受状态不明的 5xx 不能证明消息未发送，标记为 `delivery_unknown`，不自动重试，也不允许该代币再次首次发送。
- 服务启动恢复到没有 `telegram_message_id` 的 `delivery_pending` 时，同样转为 `delivery_unknown`，不自动重试。
- 安全重试期间重新检查价格和排名；若排名已经严重回落，取消发送并记录 `telegram_delay_cancelled`。
- Telegram Bot API 没有客户端 exactly-once 键。该策略选择极少量漏发风险，避免在模糊结果下主动制造重复消息，不引入消息队列或复杂回查机制。

### 23.4 SQLite 异常

不能持久化信号幂等状态时停止发送新 TG 信号，避免重启或重试后重复推送。榜单轮询可以继续，用于恢复后补充快照。

## 24. 私人开发运行与样本验收

### 24.1 私人开发频道运行

开发阶段持续运行同一套正式规则：

- 完整拉取和计算。
- 保存候选、过滤原因、真实信号、紧凑研究样本和后续结果。
- 规则通过后立即推送到私有测试频道，不等待验收时钟。
- 正式频道保持禁用，直到样本门禁通过并由人工批准当前配置指纹。

### 24.2 功能验收

- 生产代码不启动 `gmgn-cli` 子进程，也不深层导入 `gmgn-cli/dist`。
- 直接 OpenAPI 请求包含 `X-APIKEY/timestamp/client_id`，每次重试使用新的 `client_id`。
- 单层和双层响应包装契约测试均通过，第三层或未知结构会失败关闭。
- Trenches 三阶段单请求成功，请求 `limit=80`，记录实际返回量；不因当前只返回 60 就误报故障。
- 1m/5m Rank 均请求 `limit=100`；安全过滤后不足 100 条属于正常结果。
- 已知的 `near_completion` 与旧 `data.pump` 键都能正确适配。
- Trenches 曲线动量使用 `swaps_24h/net_buy_24h` 快照差分，不依赖实测缺失的 `swaps_1m`。
- 启动 Schema 自检失败时停止正式推送。
- 相同响应不产生重复新鲜快照。
- 代币离开 Top100 时生成 `exit` 快照，实时与回放均按 101 处理。
- 服务重启不重复发送已有信号。
- Telegram 模糊发送结果进入 `delivery_unknown` 且不会自动重试。
- 同代币确认时编辑原消息。
- Security 失败不会误推。
- 单个代币 Security 契约失败按候选失败关闭并标记 degraded；连续 3 次失败才将 Security 依赖标记为 failed，任一成功立即恢复。
- 正式发送使用的 Security 年龄不超过 10 秒。
- 全局限频与创建者限频可回算验证。
- `/stats` 不把待评估信号计入失败。
- `no_trade/pool_removed` 不会从倍数命中率分母消失；前者收益为 0%，后者保守为 -100%；`api_missing` 会降低并展示数据覆盖率。
- 相同快照和配置版本回算结果完全一致。
- 回算报告展示 `upstream_filter_version`、`adapter_version` 和 `sampling_level`。

### 24.3 性能验收

```text
条件满足 → TG发送 影子期 P95 < 5秒
1m极速信号 首个包含候选的GMGN响应 → TG发送 影子期 P95 < 10秒
以上延迟至少各有30个有效观察；1m极速路径至少20个样本
当前配置累计至少10000次GMGN请求，成功率≥99%，且无失控429和关键Schema失败
确定性失败重试和服务重启不产生重复Telegram消息
模糊发送结果不自动重试，并能从日志和状态中识别
```

### 24.4 质量基线

质量复盘按有效 T+1h 样本推进：30 个进行首次复盘，100 个形成第一版基线，此后每新增 50 个复盘一次。正式频道批准还要求三条首次触发路径各至少 20 个样本、T+1h 结果覆盖率至少 90%。至少观察：

```text
每小时信号数量
1.2x/1.5x/2x/3x/5x命中率
最高倍数中位数
达到2x中位用时
无交易率/已确认撤池率
中位MFE（详细诊断）
中位MAE
曲线毕业率
极速信号立即回落率
双榜确认率
```

调参时优先调整现有阈值，不新增更多指标。

## 25. 实施阶段建议

### 阶段 1：实时数据与存储

- 直接 HTTP `GmgnHttpClient`、双层响应解包与统一限速器。
- Trenches、1m Rank、5m Rank。
- Schema 契约自检、地址校验与小写去重、新鲜快照。
- SQLite 表结构与配置版本。

### 阶段 2：Detector 与 Security

- 通用硬过滤。
- 曲线加速、1m 极速、跨来源触发。
- Security 预热和缓存。
- 回落取消和幂等控制。

### 阶段 3：Telegram

- 简洁信号卡片。
- 消息编辑确认。
- 固定域名链接、元数据转义和复制合约按钮。
- 创建者限频、全局限频。

### 阶段 4：结果、统计与回算

- 1m/5m/15m/1h 结果采集。
- 30 秒 Kline 离线评估。
- `/stats` 和每日统计卡片。
- 历史重放与配置对比。

### 阶段 5：样本验收

- 私人频道立即接收真实规则信号，持续累计版本化结果。
- 在 30、100 和之后每新增 50 个有效 T+1h 样本时复盘质量。
- 验证三条路径样本量、覆盖率、延迟和累计请求稳定性。
- 阈值回算对比。
- 确认正式频道上线参数。

## 26. 后续交易接口预留

虽然 V1 不交易，但信号事件需要保留：

```text
signal_id
token_address
stage
first_seen_at
qualified_at
sent_at
first_seen_price
sent_price
security_snapshot
config_version
```

未来交易模块只订阅已经产生的信号事件，不修改 Detector。交易鉴权在独立 `GmgnSignedClient` 中实现 `X-Signature`，不得把交易私钥或签名逻辑加入当前只读 `GmgnHttpClient`。这样可以在不破坏当前信号系统的情况下增加 GMGN Swap、限价、止盈止损等能力。

## 27. 已知限制

- GMGN 没有公开榜单数据更新 SLA，链上变化到 GMGN 可见的时间必须实测。
- GMGN 官方字段说明、直接 API 原始包装与 CLI 归一化输出存在差异；因此依赖启动 Schema 自检和显式适配，不能只按文档猜测。
- 直接 OpenAPI 没有公开响应时间 SLA，468～605ms 只是本次 Rank 小样本，不代表长期性能。
- Trenches 请求上限为每阶段 80，但本次 BSC 实测只返回 60；实际返回数量由上游决定。
- 单数据源架构简单，但 GMGN 故障会成为单点问题。
- 热榜和短时涨幅可能被操纵，硬过滤不能保证未来不会 Rug。
- 当前 Security 不是可靠的卖出模拟；`can_sell/can_not_sell` 不参与“可卖”结论。
- Bonding Curve 的极早信号天然风险极高，GMGN 风险筛选通过不等于低风险。
- 30 秒 Kline 计算的 MFE/MAE 是离散近似，不代表真实可成交价格。
- 推送价格不等于用户实际成交价格，剧烈波动时可能产生较大滑点。
- 历史回算只能覆盖系统开始保存数据之后的时间。

## 28. 参考资料

- [GMGN Market 官方能力与限流说明](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md)
- [GMGN Token 官方能力说明](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md)
- [GMGN 官方 OpenApiClient 与鉴权实现](https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts)
- [GMGN CLI 官方 npm 包（仅作开发诊断）](https://www.npmjs.com/package/gmgn-cli)
- [Telegram Bot API：InlineKeyboardButton / CopyTextButton](https://core.telegram.org/bots/api#inlinekeyboardbutton)
- [BNB Chain：Four.meme Bonding Curve 与 PancakeSwap 迁移说明](https://www.bnbchain.org/en/blog/how-to-launch-a-memecoin-on-bnb-chain-a-step-by-step-guide)
- [USENIX Security：BSC Token Spammer、Rug Pull 与 Sniper Bot 研究](https://www.usenix.org/system/files/usenixsecurity23-cernera.pdf)
- [跨链 Meme Coin 市场操纵研究](https://arxiv.org/abs/2507.01963)

## 29. 最终结论

V1 的实时主链路固定为：

```text
直接 GMGN OpenAPI（单例 GmgnHttpClient）
                ↓
GMGN Trenches + 1m Top100 + 5m Top100
                ↓
       地址合并与新鲜快照
                ↓
       硬安全过滤与简单动量
                ↓
         Token Security复查
                ↓
          Telegram简洁卡片
```

回算和统计链路固定为：

```text
变化快照 + 信号记录 + 紧凑研究样本 + 后续Kline
                ↓
         参数重放与结果计算
                ↓
       命中率、涨幅、回撤、延迟
```

该方案固定采用直接 GMGN OpenAPI 作为生产数据链路，`gmgn-cli` 仅用于调试。它保留 GMGN 聚合热榜、Bonding Curve 极早机会和秒级推送能力，同时通过单例 HTTP Client、静默候选池、安全硬过滤、动量确认、消息去重和离线回算控制复杂度与噪音。
