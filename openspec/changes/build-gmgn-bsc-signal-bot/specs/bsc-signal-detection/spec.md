## Purpose

定义只面向 BSC 的简单、可解释信号筛选行为，覆盖 Bonding Curve 早期启动和 GMGN 热榜动量，同时以硬风险规则、回落检查及限频降低噪音。

## ADDED Requirements

### Requirement: Startup baseline protection
系统 SHALL 为 Trenches、1m Rank 和 5m Rank 分别建立首次成功响应基线；某来源建立基线前不得参与检测，但不阻塞已完成基线的独立路径。不推送启动前已存在且没有新变化的代币，只处理启动后的新上榜、明显排名变化或曲线加速。已发送状态 SHALL 从持久化存储恢复。

#### Scenario: Service restarts while tokens are already ranked
- **WHEN** 服务启动后某个来源首次成功返回
- **THEN** 系统为该来源建立基线且不把其中已有代币批量作为新信号发送

#### Scenario: One source cannot establish a baseline
- **WHEN** 5m Rank 尚未首次成功，但 1m Rank 已建立基线并产生新的独立极速变化
- **THEN** 系统允许评估不依赖 5m Rank 的极速路径，并暂停所有依赖 5m Rank 的路径

### Requirement: Bonding Curve acceleration trigger
系统 SHALL 在同一代币至少两个、最近 15 秒的 Trenches 新鲜快照上评估曲线路径。候选 MUST 同时满足累计 swaps≥20、holders≥20、累计净买入>0、进度增长≥2 个百分点、holders 增长≥3、累计净买入增长>0，并满足累计 swaps 增长≥10或 smart money 数量≥1。

#### Scenario: Curve token accelerates safely
- **WHEN** `new_creation` 或 `near_completion` 代币满足全部曲线条件并通过安全检查
- **THEN** 系统生成 Bonding Curve 首次信号候选

#### Scenario: Cumulative metric decreases
- **WHEN** 曲线累计 swaps 或净买入字段在新快照中下降
- **THEN** 系统重置该字段基线且本轮不触发曲线信号

### Requirement: Fast 1m rank trigger
系统 SHALL 在最近 10 秒至少两个 1m Rank 新鲜快照上评估极速路径。候选 MUST 达到当前 rank≤10、排名提升≥15 位且 buys>sells，并额外满足 holders 增长≥3、同时存在于 Trenches 或 smart money 数量增加中的至少一项。

#### Scenario: Token rapidly enters the top ten
- **WHEN** 候选满足极速排名、买卖方向和任一真实参与增强条件并通过安全检查
- **THEN** 系统生成 1m 极速突破首次信号候选

### Requirement: Cross-source startup trigger
系统 SHALL 要求跨来源候选当前 1m rank≤30、排名提升≥10 位且 buys>sells，同时存在于 Trenches 或当前 5m rank≤80，并且 holders 增长≥3或 1m swaps 增长≥10。

#### Scenario: Rank momentum is confirmed by another source
- **WHEN** 候选满足 1m 动量、来源确认和参与增长条件并通过安全检查
- **THEN** 系统生成跨来源启动首次信号候选

### Requirement: Hard security rejection
系统 SHALL 以布尔硬条件而非综合分决定风险。`is_honeypot=true`、`is_wash_trading=true`，或 rug、bundler、insider、rat trader、entrapment 任一比例>0.30，或 dev/creator 持仓>0.15，或 Top10 持仓>0.50 SHALL 阻止正式信号；同一字段来源冲突时 SHALL 采用更危险值。

#### Scenario: Any hard risk threshold is exceeded
- **WHEN** 候选命中任一硬拒绝条件
- **THEN** 系统记录具体拒绝原因且不发送正式信号

#### Scenario: Optional enhancement field is missing
- **WHEN** Rug、Wash、Rat 或 Entrapment 等可选增强字段缺失，但来源所需关键安全字段完整
- **THEN** 系统记录 unknown，并按该来源的明确缺失策略继续评估，而不把 unknown 当作安全值

### Requirement: Lifecycle-aware safety rules
所有正式信号 MUST 具备明确的 Honeypot、源码开源、买卖税和 Top10 字段。已毕业或 DEX 代币还 MUST 满足源码开源、Owner 已放弃、Honeypot=false、买卖税均≤10%，并且 `burn_status=burn` 或可解析的最大 lock 明细≥50%；仅有 `burn_status=yes` 或无比例的 locked 标记不足以放行。Bonding Curve 代币 SHALL 跳过尚不存在的 Owner Renounced、DEX 流动性和 LP 条件，但 MUST 满足源码开源、Honeypot=false、买卖税均≤10%、Top10≤50%，具备 Bundler、Insider、Dev Team 和 Creator 持仓字段及成功的 Trenches Safe 结果。

#### Scenario: Graduated token has unknown LP state
- **WHEN** 已毕业候选无法证明 LP 已 burn 或至少锁定 50%
- **THEN** 系统不发送正式信号

#### Scenario: Curve token has no DEX pool yet
- **WHEN** 曲线候选满足曲线关键安全字段但尚未建立 DEX Pool
- **THEN** 系统不因缺少 DEX 流动性或 LP Lock 而拒绝该候选

#### Scenario: Curve token lacks a universal Security field
- **WHEN** 曲线候选的 Open Source、Honeypot、税率或 Top10 任一字段未知
- **THEN** 系统保留候选等待字段补齐且不发送正式信号

#### Scenario: Curve token lacks a source-specific risk field
- **WHEN** 曲线候选的 Bundler、Insider、Dev Team 或 Creator 持仓任一字段未知
- **THEN** 系统保留候选等待字段补齐且不发送正式信号

### Requirement: Pre-send fallback cancellation
系统 SHALL 在 Security 完成后使用最新快照重新检查候选。热榜候选出现相对期间最佳排名回落≥15、连续两个 Rank 新鲜快照离开 Top100、buys≤sells、swaps 相比候选时下降≥40%或安全状态恶化时 MUST 取消；曲线候选在进度、holders 和净买入均停止增长时 MUST 取消。

#### Scenario: Candidate fades during Security latency
- **WHEN** 候选等待 Security 时命中任一回落取消条件
- **THEN** 系统取消发送并保存取消原因供回算

### Requirement: Double-rank confirmation
系统 SHALL 将双榜确认为首次信号后的增强状态而非首次发送前置条件。候选在连续两次 Rank 来源更新中保持 1m≤30、5m≤50、buys>sells，且 1m 相比首次继续提升≥5、5m 相比首次进入继续提升≥3，并伴随 holders 或 swaps 增长时 SHALL 获得确认。

#### Scenario: Existing signal gains confirmation
- **WHEN** 已发送代币满足双榜确认条件
- **THEN** 系统更新同一信号记录和原 Telegram 消息，不创建第二个生命周期信号

#### Scenario: Token directly qualifies for double-rank confirmation
- **WHEN** 未发送代币首次评估时已满足双榜确认及安全条件
- **THEN** 系统直接创建一条高优先级双榜信号

### Requirement: Extreme-move classification
系统 SHALL 保存首次发现、满足条件和发送时价格或市值。热榜代币发现至发送涨幅<30%为普通，30%–100% SHALL 标注快速拉升，>100% SHALL 标注观察型；曲线代币当前市值相对首次发现<1.5倍为普通，达到1.5倍但<2.0倍 SHALL 标注快速拉升，达到或超过2.0倍 SHALL 标注观察型。观察型仍可发送但 MUST NOT 显示成普通入场信号。

#### Scenario: Token multiplies before the message is sent
- **WHEN** 候选满足观察型阈值且其他触发和安全条件通过
- **THEN** 系统发送带极端波动提示的观察型信号

### Requirement: Noise controls
系统 SHALL 为每个 BSC 合约只创建一个生命周期信号；合法 Creator 地址 30 分钟最多产生一条首次信号。60 秒滚动窗口最多发送 3 条首次信号，其中普通信号最多 2 条并为高优先级保留 1 个位置；被限频抑制的候选 SHALL 被持久化。

#### Scenario: Ordinary signal capacity is exhausted
- **WHEN** 最近 60 秒已发送 2 条普通首次信号但总数少于 3
- **THEN** 系统抑制新的普通信号，仅允许直接双榜或 1m+Trenches 重合的高优先级信号使用剩余位置

#### Scenario: Creator address is unknown
- **WHEN** 候选没有合法非空 Creator 地址
- **THEN** 系统不把它与其他 Creator 缺失代币放入同一个 Creator 冷却键

#### Scenario: An unsent candidate receives a fresh trigger later
- **WHEN** 曾被拒绝、取消或限频抑制的代币在后续新鲜事件中重新满足全部触发和安全条件
- **THEN** 系统更新同一未发送记录并重新评估，不排队补发旧信号；`delivery_pending`、`delivery_unknown`、`sent` 或 `confirmed` 记录阻止再次首次发送
