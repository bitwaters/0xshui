## Context

当前仓库只有已确认的 V1 开发方案，没有业务代码或既有规范。完整需求来源为 `outputs/GMGN-BSC-TG信号机器人-V1-开发方案.md`，提案动机见 `proposal.md`。

系统受以下约束：只支持 BSC；GMGN 是唯一数据供应商；V1 只发送 Telegram 信号；需要覆盖 Bonding Curve 极早阶段和 GMGN 1m/5m 聚合热榜；正式信号必须经过安全硬过滤；可控延迟目标为秒级；部署和调参必须保持简单。

2026-08-24 的官方文档与只读抽样已确认 Exist Auth、接口权重、Rank/Trenches/Security/Kline/Pool 的核心字段及单层/双层响应包装。上游仍可能调整返回数量、可选字段和包装，因此 Schema 边界与影子运行是设计的一部分，而不是一次性开发检查。

## Goals / Non-Goals

**Goals:**

- 使用单进程和单 SQLite 文件完成实时采集、候选检测、安全复查、Telegram、结果统计与回算。
- 将 GMGN 变化隔离在 HTTP/Adapter 边界，使检测规则只消费稳定内部模型。
- 以三条布尔检测路径覆盖早期和热榜动量，不引入综合评分框架。
- 保证实时检测和离线回放共享规则、事件顺序与配置语义。
- 在 GMGN、Telegram 或 SQLite 异常时失败关闭正式推送，避免误报和重复消息。

**Non-Goals:**

- 不实现交易签名、钱包托管、Swap/Order、仓位或止盈止损。
- 不实现 Solana、多数据源交叉验证、自建链上索引或独立卖出模拟。
- 不把 Market Signal、Hot Search、钱包跟踪、holders/traders 全量扫描加入实时主链路。
- 不建设微服务、消息队列、Redis、Web Dashboard 或通用规则 DSL。
- 不承诺 GMGN 可见前的链上延迟，也不把历史价格触达解释为实际可成交收益。

## Decisions

### 1. 单进程分层架构

固定使用 Node.js 22、TypeScript strict、原生 fetch/Undici、Zod、grammY、better-sqlite3 与 Pino。进程内划分为：配置与启动门禁、GMGN HTTP Client、各接口 Adapter、统一调度器、Snapshot Store、Detector、Security Gate、Telegram Publisher、Outcome Worker、Stats Aggregator、Replay Runner 和 SQLite Repository。

这些是代码边界而不是可独立部署服务。所有实时状态只在单进程内协调，SQLite 是唯一持久化组件。

选择理由：V1 负载受 GMGN 限速而非本地吞吐限制，单进程能减少部署、网络、幂等和事件排序复杂度。替代方案 Redis/Kafka/微服务会扩大故障面，当前没有可量化收益。

### 2. 生产直接访问 OpenAPI，CLI 仅作诊断

实现一个全进程单例 GMGN HTTP Client，只负责 URL、Exist Auth、连接复用、超时、响应体限制、重试、429 和显式响应解包。Adapter 负责每个接口的 Zod Schema、别名和归一化；业务条件不得进入 Client 或 Adapter。

选择理由：本机抽样显示直接 Rank 约 468–605ms，而 CLI 暖请求约 2.6–3.9s，CLI 子进程开销无法满足 1 秒轮询。直接 Client 也能固定生产依赖面。替代方案导入 `gmgn-cli/dist` 会依赖未承诺稳定的内部模块，反复执行 CLI 则增加延迟和资源抖动。

Client 暴露五个用例方法：Trenches、Rank、Security、Kline、Pool。未来交易使用完全独立的 Signed Client，不向当前 Client 增加私钥。

### 3. 一秒统一调度与限速预算

一个 1 秒 Tick 使用固定四拍轮转：`Trenches → 1m Rank → Trenches → 5m Rank`。因此 Trenches 每 2 秒、两个 Rank 各每 4 秒拉取一次，且每个 Tick 只发一个基础 HTTP 请求；每个来源仍最多一个在途请求，慢来源只跳过自身排定 Tick。基础平均负载为 1 request/s、2 weight/s，本地令牌桶上限为 4 weight/s；余量供按需 Security，离线 Kline/Pool 优先级最低。

Security 队列最大并发为 3，但仍受同一令牌桶约束，重试也消耗令牌。429 进入全局状态机：只接受合法未来 reset header/body，并在 reset 后增加 1 秒安全缓冲；缺失或非法时默认冷却 5 分钟，并把 `cooldown_until` 写入 `runtime_state`。重启时先恢复该状态，恢复顺序为实时来源、Security、离线作业。普通网络/5xx 只重试一次，429 不走普通重试。

选择理由：2026-08-25 实际部署证实每秒并发三个基础请求会持续触发 429；固定轮转在不增加三个周期配置的前提下保留秒级发现，并为候选 Security 留出请求余量。替代方案为每个接口设置独立 Cron 会让重叠、预算和调参更难理解。

### 4. Adapter 失败关闭与内部模型

HTTP 层返回 `unknown`。解包器只接受已验证的单层或双层 `code=0` 包装；最多两层。每个 Adapter 只提取规则和展示实际需要的字段，允许已证实的类型与字段别名，其他结构失败。

内部 token key 固定为小写 BSC 地址；外部字符串先做地址校验。比例只接受 0–1 有限数值，布尔只接受明确枚举，禁止 JavaScript truthiness。GMGN 元数据从进入系统起标记为不可信，Telegram 层再次转义和截断。

选择理由：宽松 passthrough 会在上游字段变化时静默产生错误信号；递归解包又可能误把业务 `data` 字段当包装。严格边界会牺牲部分可用性，但安全信号系统应优先停止误报。

### 5. 来源提交事件而非复杂事件总线

每个来源在首次成功响应时独立建立基线；尚未建立基线的来源不参与检测，但不阻塞其他来源的独立路径。后续成功响应与上一成功结果做差分，形成批次内的 enter/update/exit。每个批次在一个事务中分配一个全局递增 `ingest_seq`，批次内多行共享该值；Security 完成事件也使用同一序列空间。

内存为每个 token 保存最近 60 秒且最多 10 个新鲜快照。相同数据不创建事件；失败响应不推断 exit。跨来源首次触发只读取 10 秒内数据。

选择理由：`ingest_seq` 足以重放异步到达顺序，无需 Kafka 或 event-sourcing 框架。只保存变化显著降低 SQLite 体积，同时保留规则需要的时序。

### 6. 纯函数 Detector 与显式状态机

Detector 输入为当前 token 聚合状态、时间窗口、Security 状态和版本化配置，输出为候选、拒绝、取消、发送、确认或抑制决策，不执行网络或数据库操作。

三条首次路径按 `bsc-signal-detection` spec 固定。内存候选状态为 `observing -> security_pending -> qualified`；持久化结果可为 `rejected/cancelled/suppressed/delivery_pending/delivery_unknown/sent/confirmed`。未发送的 `rejected/cancelled/suppressed` 记录在后续新鲜事件到达时可以原地重新评估，但不排队延迟补发旧条件；`delivery_pending/delivery_unknown/sent/confirmed` 不再进行首次发送。

一次来源批次内同时触发多个候选时，按高优先级、触发时间、token key 固定排序后使用 60 秒滚动限额。不同时间的候选不等待聚合排序，以免牺牲秒级延迟。

选择理由：纯规则函数让实时与回算复用同一逻辑，也避免规则框架或评分模型带来的维护负担。

### 7. 来源感知的 Security Gate

Security Gate 将 GMGN 上游过滤与按需 Token Security 合并，冲突字段取更危险值。所有路径要求明确的 Honeypot、Open Source、税率和 Top10；已毕业路径额外要求 Owner 与 LP 证据；曲线路径不要求尚不存在的 DEX LP，但额外要求 Safe Trenches 和明确的 Bundler、Insider、Dev Team 与 Creator 持仓字段。

Security 预热只覆盖 1m Top30 或低门槛曲线候选，成功结果缓存 60 秒；失败的非紧急预热同样在内存抑制 60 秒，避免对同一不完整代币反复请求。发送时最大年龄 10 秒，真正满足发送条件的紧急刷新不受失败预热抑制；等待刷新期间持续执行回落检查。

选择理由：全榜 Security 扫描会消耗请求预算，推迟真正候选；统一要求 DEX LP 又会错误消灭 Bonding Curve 机会。替代方案“未知全部放行”风险不可接受，“未知全部拒绝”则会使实测缺失可选字段的曲线路径接近零信号。

### 8. Telegram 持久化去重和原消息确认

发送前通过 SQLite 原子条件更新将唯一 token lifecycle 记录置为 `delivery_pending`，只有成功更新者可以调用 Telegram，从而处理多个来源几乎同时触发的情况；成功后保存 message id 并进入 `sent`。只有能够证明消息未被接受的错误才允许最多 3 次总尝试。请求已发送后的超时、连接中断或接受状态不明的 5xx 标记为 `delivery_unknown`，不自动重试，也不允许该合约再次首次发送。启动恢复时，任何缺少 message id 的 `delivery_pending` 同样转为 `delivery_unknown`，因为进程无法证明崩溃发生在发送前还是发送后。双榜确认只更新已知 message id 的原消息。

卡片由结构化 view model 渲染，不直接插入上游 HTML。链接只允许从已验证合约生成 GMGN 和 BscScan 固定地址。名称与 symbol 限长、转义并清理控制字符。

选择理由：Telegram Bot API 没有客户端 exactly-once 键，网络结果模糊时无法同时保证“不漏发”和“不重复”。V1 采用简单的 at-most-once 偏好：SQLite 唯一约束处理本地重复，模糊结果失败关闭并交给日志诊断，不增加消息队列或回查服务。编辑确认比再次推送更能控制频道噪音。

### 9. 结果评估、版本统计与样本验收

Outcome Worker 使用持久化到期作业，在 T+15m、T+1h 拉取从 sent_at 开始的 30 秒 Kline。每个检查点在到期后 10 分钟内最多重试 3 次并写入终态。撤池仅在已有 Pool 基线和二次成功复查证据完整时成立。

统计查询读取已落库结果，不触发实时 GMGN 请求。只有明确 `sent/confirmed` 的消息进入推送和收益统计，`delivery_unknown` 只进入运维指标。默认 `/stats` 展示当前 `config_version` 的累计数据，7d/30d 也只统计当前版本，避免混合不同阈值。版本化时仅规范化忽略部署开关 `mode` 和 `telegram.enabled`，因此私人 Shadow 切换到正式频道不会丢失样本；任何检测、安全、轮询、限频或结果参数变化仍生成新版本。有效样本只计入已成熟的 T+1h `completed/no_trade/pool_removed`；30 个用于首次复盘，100 个形成基线，此后每新增 50 个提示下一次复盘。

正式频道的人工批准使用样本门槛：当前配置至少 100 个有效 T+1h 信号，三条路径各至少 20 个，结果覆盖率至少 90%，延迟至少 30 个样本并通过原 P95 目标，且同一配置累计至少 10,000 次 GMGN 请求、成功率至少 99%、无失控 429 和关键 Schema 失败。运行时长和心跳仍作为运维上下文展示，但不是质量通过条件。

选择理由：实时路径不应为统计阻塞；明确终态和覆盖率可避免数据缺失导致幸存者偏差。

### 10. SQLite 数据模型、紧凑研究样本与保留

核心表为 `token_snapshots`、`security_checks`、`signals`、`signal_outcomes`、`research_samples`、`research_outcomes`、`config_versions`、`runtime_state`。数据库启用 WAL、外键、busy timeout 和 `auto_vacuum=INCREMENTAL`。`signals.token_key` 唯一；配置保存内容哈希和版本号。

高频候选保存所有变化，普通榜单 update 最多每 5 秒一条。Security 已通过的预热候选在每分钟最多 5 个的全局上限内，每个 token/config 只保存一份当时的最近市场窗口、Security、首次发现基线和价格，并复用低优先级 Outcome Worker 采集 15m/1h 结果。研究样本不计入 TG 推送统计；回算结果明确披露它是预热候选的受限样本、不包含完整跨 token 限频语义。每日执行保留清理、WAL checkpoint 和 incremental vacuum；5 GB 软上限先清普通榜单快照，再清最旧辅助研究样本，真实信号和结果不因容量压力删除。

选择理由：better-sqlite3 的同步事务有利于严格事件顺序和小型单进程系统。替代 PostgreSQL 会增加部署依赖；仅内存存储无法支持幂等、结果统计和回算。

### 11. 配置验证和可观测性

YAML 只包含非敏感参数；API Key、Bot Token 和 Chat ID 通过环境或 Secret 注入。启动时校验参数范围、凭据、数据库迁移和一次轻量 GMGN Schema/Auth 自检。若 GMGN HTTPS 响应包含可信 `Date` Header，则同时检查本机时钟偏差；Header 缺失时不引入第三方时间服务，依赖鉴权自检发现明显时间错误。任何门禁失败都不启动正式推送。

Pino 记录结构化事件和 request correlation id，但对 API Key、Bot Token、query auth、代币原始元数据和错误响应做脱敏/截断。核心指标通过日志和 `/stats detail` 暴露，V1 不建设 Dashboard。

## Risks / Trade-offs

- [GMGN 是单点，接口或 Schema 变化会停止信号] → Adapter 契约测试、启动自检、失败关闭、结构化告警，并保留 CLI 仅作人工诊断。
- [高频榜单加候选 Security 可能触发限流] → 每秒一个基础请求的固定轮转、本地 4 weight/s 令牌桶、候选预热边界、离线任务降级，以及 reset 后额外 1 秒的全局冷却缓冲。
- [GMGN 可见时间不等于链上事件时间] → 分别记录 source captured、qualified、security、sent 时间；影子期只承诺 Bot 可控延迟。
- [曲线信号风险高且没有 DEX LP] → 使用生命周期感知的必需安全字段、观察型提示和单独统计曲线毕业率，不宣称绝对安全。
- [极端行情下价格可能在发送前成倍变化] → 保存多阶段价格、市值并执行发送前回落检查；高涨幅仍可作为明确标记的观察型信号。
- [严格 Schema 会降低可用性] → 只对关键结构失败关闭，可选增强字段按明确策略记录 unknown；恢复前通过新样本更新契约测试。
- [SQLite 文件增长或损坏影响推送] → 变化存储、分层采样、保留和软上限；无法写投递状态时停止新消息，并要求常规备份。
- [Telegram 返回模糊发送结果，无法证明消息是否已创建] → 预写 `delivery_pending`，模糊结果转为 `delivery_unknown` 且不自动重试；接受极少量漏发可能，避免主动制造重复信号。
- [30 秒 Kline 无法代表实际成交] → 对发送所在蜡烛做边界校正，统计展示价格触达说明并同时给出 MAE 与覆盖率。
- [上游 Safe 过滤变化削弱回算可比性] → 每个快照保存 upstream filter、adapter 和 sampling 版本，禁止跨不兼容版本直接汇总。

## Migration Plan

1. 初始化 Node.js/TypeScript 工程、配置校验、SQLite migration 和结构化日志；此阶段不连接正式 Telegram 频道。
2. 实现 GMGN Client、Adapter、统一限速与三来源采集，以录制样本和契约测试验证当前 BSC Schema。
3. 实现变化事件、Detector、Security Gate、候选状态机和确定性单元测试，先写入模拟信号。
4. 接入私有测试 Telegram，验证持久化去重、模糊发送保护、卡片、确认编辑、限频和安全重试。
5. 实现结果作业、统计命令与 Replay Runner，使用固定 fixture 验证实时/回放一致。
6. 私人开发频道立即接收按正式规则通过的信号；在 30/100/每新增 50 个有效样本节点复盘，达到样本量、覆盖率、延迟和请求稳定性门禁后才允许人工批准正式 Chat ID。
7. 部署回滚时停止进程、恢复上一应用版本和兼容的配置；数据库 migration 必须向前兼容或在部署前创建备份。若 GMGN 契约变化，保持正式推送关闭，直到 Adapter 与 fixture 更新并重新通过影子验证。
