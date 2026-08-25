## Purpose

定义机器人如何稳定、低延迟地取得并归一化 GMGN 的 BSC 市场与安全数据，使后续检测只依赖可验证的新鲜事件，并在上游异常时停止不可靠推送。

## ADDED Requirements

### Requirement: Direct read-only GMGN access
系统 SHALL 仅通过直接 HTTP 方式访问 `https://openapi.gmgn.ai` 的只读接口，并在每次请求中发送 `X-APIKEY`、当前 Unix 秒 `timestamp` 和新生成的 UUID `client_id`。V1 MUST NOT 读取交易私钥、生成 `X-Signature`、启动 `gmgn-cli` 子进程或导入其内部模块。

#### Scenario: Send an authenticated market request
- **WHEN** 调度器请求任一 V1 GMGN 接口
- **THEN** 请求携带只读鉴权字段且不包含交易签名或私钥

#### Scenario: Retry a failed request
- **WHEN** 网络错误或 5xx 触发唯一一次快速重试
- **THEN** 重试使用新的 `timestamp` 和 `client_id`

### Requirement: Maximum BSC source coverage
系统 SHALL 以一个 1 秒 Tick 按 `Trenches → 1m Rank → Trenches → 5m Rank` 固定轮转，每个 Tick 最多启动一个基础请求，使 Trenches 每 2 秒、两个 Rank 各每 4 秒更新。Trenches SHALL 请求 `new_creation`、`near_completion`、`completed`、每阶段 `limit=80` 和 `filter_preset=safe`；两个 Rank SHALL 请求 `limit=100` 及 `not_honeypot`、`verified`、`renounced` 过滤。

#### Scenario: Poll all realtime sources
- **WHEN** 连续四个调度 Tick 到达且三个来源均可用
- **THEN** 系统依次发起 Trenches、1m Rank、Trenches、5m Rank，并保持每个 Tick 最多一个基础请求

#### Scenario: A source is still in flight
- **WHEN** 某来源在下一个 Tick 到达时仍有请求未完成
- **THEN** 系统只跳过该来源且继续调度其他可用来源

#### Scenario: GMGN returns fewer than the requested limit
- **WHEN** Trenches 每阶段少于 80 条或 Rank 少于 100 条
- **THEN** 系统接受实际返回量并记录数量，不将其判定为接口故障

### Requirement: Contract validation and normalization
系统 SHALL 将 GMGN 响应视为未知数据，仅接受经过 Schema 校验的单层或双层成功包装，并将已批准的字段别名、数值和布尔表示归一化为 BSC 内部模型。未知包装、关键字段未知类型、非法地址或超出 10 MB 的响应 MUST fail closed，且不得进入正式信号检测。

#### Scenario: Accept a validated double envelope
- **WHEN** 响应为两层 `code=0` 包装且业务字段通过 Schema
- **THEN** 系统解包恰好两层并提交归一化数据

#### Scenario: Reject an unknown contract
- **WHEN** 响应出现第三层包装、非成功 code、关键字段未知类型或非法 BSC 地址
- **THEN** 系统记录 `schema_contract_failed` 且不产生候选或退出事件

### Requirement: Fresh snapshot event semantics
系统 SHALL 按来源比较相邻成功结果，只在相关字段发生变化时提交 `enter`、`update` 或 `exit` 事件。每次来源提交和 Security 完成 SHALL 获得共享、严格递增的 `ingest_seq`；请求失败、超时或 Schema 错误 MUST NOT 生成 `exit`。

#### Scenario: Token leaves a successful rank response
- **WHEN** 代币存在于上一份成功 Rank 结果但不在当前成功结果
- **THEN** 系统提交 `exit`，将排名置空并在内部按 101 处理

#### Scenario: Identical response repeats
- **WHEN** 两次成功响应中检测相关字段完全相同
- **THEN** 第二次响应不产生新鲜快照或连续确认

#### Scenario: A poll fails
- **WHEN** 当前来源请求失败或响应未通过 Schema
- **THEN** 系统保留上一份状态且不推断任何代币离榜

### Requirement: Freshness gates
系统 SHALL 仅允许最近 10 秒内成功提交的来源参与首次触发和双榜确认。来源连续 10 秒无成功响应 SHALL 被标记为陈旧，并停止依赖该来源的新信号路径。

#### Scenario: Cross-source data is stale
- **WHEN** 一条跨来源规则引用的任一所需来源超过 10 秒未成功更新
- **THEN** 该规则本轮不触发，但陈旧数据可以保留用于内部展示和诊断

### Requirement: Candidate-scoped Security checks
系统 SHALL 仅为满足预热条件的候选查询 Token Security；热榜预热条件为进入 1m Top30，曲线预热条件为累计 swaps 至少 10、holders 至少 10 且累计净买入为正。成功结果 SHALL 缓存 60 秒；失败的非紧急预热 SHALL 抑制 60 秒，但正式发送前的紧急刷新 MUST 绕过该抑制。正式发送使用的 Security 结果 MUST 不超过 10 秒。

#### Scenario: Candidate enters preheat range
- **WHEN** 一个此前未预热的代币首次满足任一预热条件
- **THEN** 系统异步排队 Security 请求而不阻塞市场来源轮询

#### Scenario: Cached Security is too old at send time
- **WHEN** 候选已满足触发条件但最近 Security 结果超过 10 秒
- **THEN** 系统刷新 Security，并在等待期间继续检查候选是否回落

#### Scenario: Security cannot be obtained
- **WHEN** Security 请求失败、超时或关键字段不完整
- **THEN** 系统不发送正式信号，并抑制该代币的重复非紧急预热，但仍允许后续发送前紧急刷新

### Requirement: Rate-limit and failure control
系统 SHALL 使用全局加权限速，固定轮转的基础实时轮询目标负载为 1 request/s、平均 weight 2/s，本地总上限为 weight 5/s，原始请求和重试均消耗预算。单请求 SHALL 在 5 秒超时；收到 429 后 SHALL 暂停全部 GMGN 请求，优先采用有效的未来 `X-RateLimit-Reset`、其次采用有效的未来 `reset_at`，并在有效 reset 后增加 1 秒安全缓冲；两者均缺失或非法时使用 5 分钟冷却。`cooldown_until` SHALL 持久化并在服务重启后继续生效，且冷却期间不得主动请求 GMGN。

#### Scenario: GMGN responds with 429
- **WHEN** 任一 GMGN 请求收到 429
- **THEN** 系统计算并持久化全局 `cooldown_until`，停止实时、Security、Kline 和 Pool 请求

#### Scenario: Rate-limit reset metadata is invalid
- **WHEN** 429 响应没有可解析的未来 reset 时间
- **THEN** 系统使用从当前时刻开始的 5 分钟冷却而不是立即重试

#### Scenario: Service restarts during a cooldown
- **WHEN** 服务启动时持久化的 `cooldown_until` 仍在未来
- **THEN** 系统继续保持全部 GMGN 请求暂停直到该时间

#### Scenario: Cooldown expires
- **WHEN** 已到明确的恢复时间
- **THEN** 系统先恢复实时榜单，再逐步恢复 Security 和离线作业

### Requirement: Offline market data isolation
系统 SHALL 仅在结果评估时查询 30 秒 Kline，并仅在已毕业信号发送后或异常结果判定时查询 Token Pool。Kline 和 Pool MUST NOT 阻塞首次 Telegram 信号。

#### Scenario: A graduated signal is sent
- **WHEN** 已毕业代币的 Telegram 消息发送成功
- **THEN** 系统异步获取 Pool 基线，不等待该请求完成才发送消息

### Requirement: Realtime acceptance gate
系统 SHALL 记录来源提交、条件满足、Security 完成、Telegram 尝试与成功时间。正式频道启用前 MUST 完成至少 72 小时影子运行，并在有可评估样本时达到：条件满足到 Telegram 成功发送 P95<5 秒，1m 极速信号从首个包含候选的 GMGN 响应到成功发送 P95<10 秒，且连续 24 小时没有冷却期间继续请求造成的失控 429。链上事件到 GMGN 可见的上游时间不计入 Bot 可控延迟。

#### Scenario: Shadow acceptance passes
- **WHEN** 影子运行已满 72 小时、各延迟指标有可评估样本且全部门槛通过
- **THEN** 系统生成可供人工批准正式频道启用的验收报告

#### Scenario: A latency gate fails or lacks samples
- **WHEN** 任一 P95 超过门槛，或对应指标没有可评估样本
- **THEN** 正式频道保持禁用，并继续影子运行或修复后重新验证

#### Scenario: Uncontrolled rate limiting occurs
- **WHEN** 24 小时窗口内系统在持久化冷却期间仍发起 GMGN 请求并导致重复 429
- **THEN** 正式频道保持禁用并记录限速门禁失败
