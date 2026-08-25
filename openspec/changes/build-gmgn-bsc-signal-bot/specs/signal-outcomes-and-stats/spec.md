## Purpose

定义信号发出后的统一评估和统计口径，使用户能够判断推送数量、命中质量、潜在涨幅、回撤、延迟与数据缺失，而不把价格触达误当作真实成交收益。

## ADDED Requirements

### Requirement: Two-stage outcome collection
系统 SHALL 为每条首次信号在 T+15m 和 T+1h 各执行一次离线评估。T+15m SHALL 计算 1m、5m、15m 收益和 15m MFE/MAE；T+1h SHALL 补齐 1h 收益和 1h MFE/MAE，收益基准统一为发送前最终 `sent_price`。

#### Scenario: Fifteen-minute checkpoint matures
- **WHEN** 信号发送满 15 分钟且 Kline 可用
- **THEN** 系统保存 1m/5m/15m 收益及 15m 最大有利和不利波动

#### Scenario: One-hour checkpoint matures
- **WHEN** 信号发送满 1 小时且 Kline 可用
- **THEN** 系统保存 1h 收益及完整 1h MFE/MAE

### Requirement: Candle boundary correctness
系统 SHALL 使用开盘时间不早于 `ceil(sent_at/30s)*30s` 的 30 秒 Kline；发送到下一根边界之间的波动只能使用已保存实时价格快照，以避免计入信号发送前的蜡烛高低点。每个 T 检查点价格 SHALL 取不晚于 `sent_at+T` 的最后一根已完成 30 秒蜡烛收盘价，收益为 `(price_T-sent_price)/sent_price`；MFE 使用区间最高价，MAE 使用区间最低价。

#### Scenario: Signal occurs mid-candle
- **WHEN** `sent_at` 位于一根 30 秒蜡烛中间
- **THEN** Kline 统计从下一根完整蜡烛开始，并仅用实时快照补充中间短区间

#### Scenario: A checkpoint falls between available candles
- **WHEN** 检查点时刻没有完全同时间戳的蜡烛
- **THEN** 系统使用检查点之前最后一根已完成蜡烛的收盘价且不读取检查点之后的数据

### Requirement: Terminal outcome states
每个观察检查点 SHALL 在到期后 10 分钟内进入 `complete`、`no_trade`、`pool_removed`、`api_missing` 或 `retry_exhausted` 之一。结果查询最多重试 3 次，不得无限保持待评估。

#### Scenario: No post-signal trades occur
- **WHEN** Kline 请求成功且返回有效空数据，并且已毕业代币经 Pool 复查仍存在有效流动性，或曲线代币在检查点前后均有新鲜 Trenches 数据且累计 swaps 没有增加
- **THEN** 系统标记 `no_trade`，收益记 0% 并按未命中计入

#### Scenario: Empty Kline lacks corroborating data
- **WHEN** Kline 成功返回空数据，但 Pool 或 Trenches 证据不足以确认无交易
- **THEN** 系统标记 `api_missing` 而不是猜测 `no_trade` 或 `pool_removed`

#### Scenario: Data remains unavailable
- **WHEN** GMGN 数据缺失或重试耗尽且不能证明无交易或撤池
- **THEN** 系统标记 `api_missing` 或 `retry_exhausted`，不进入命中率但降低数据覆盖率

### Requirement: Conservative pool removal classification
系统 MUST NOT 仅凭 Kline 为空判断撤池。只有此前成功保存有效 DEX 池、随后 Kline 为空、低频 Pool 复查成功确认原池缺失或流动性为 0，且没有可用替代池时，系统 SHALL 标记 `pool_removed` 并使用 -100% 保守收益。曲线代币尚无 DEX Pool 或 Pool API 失败 MUST NOT 被标记为撤池。

#### Scenario: Previously valid pool disappears
- **WHEN** 已毕业信号满足全部撤池证据且无替代池
- **THEN** 系统标记 `pool_removed`、按失败计入并记录 -100% 收益

#### Scenario: Curve token has no pool
- **WHEN** 未毕业曲线代币的 Kline 和 DEX Pool 均不存在
- **THEN** 系统不据此判定撤池

### Requirement: Hit-rate definitions
系统 SHALL 将“15 分钟内最高涨幅≥30%”定义为 15m 命中，将“1 小时内最高涨幅≥100%”定义为 1h 大涨。尚未到期和数据未知样本 MUST NOT 进入命中率分母；`no_trade` 和 `pool_removed` SHALL 进入失败样本。只有 `sent` 和 `confirmed` 信号进入推送数和结果统计；`delivery_unknown` 只进入运维失败指标。

#### Scenario: Mixed evaluation states are summarized
- **WHEN** 统计区间内同时存在完成、待评估、无交易、撤池和数据未知信号
- **THEN** 系统按固定分母规则计算命中率并单独展示完成数、待评估数和覆盖率

### Requirement: Balanced quality statistics
系统 SHALL 展示推送数、命中率、1m/5m/15m/1h 收益、MFE、MAE、曲线毕业率、双榜确认率、信号来源拆分和端到端延迟。曲线信号在 T+1h 前出现 GMGN `completed` 事件时记为已毕业；T+1h 时仍有新鲜 Trenches 数据且处于 `new_creation/near_completion` 时记为未毕业；其他情况记为毕业状态未知。曲线毕业率 SHALL 等于已毕业数除以已毕业加未毕业数，未知样本只降低覆盖率。双榜确认率 SHALL 等于 `confirmed` 数除以全部 `sent+confirmed` 首次信号数。默认卡片的收益、MFE、MAE 和延迟 SHALL 使用中位数；详细统计可以额外展示平均延迟。系统 SHALL 明确最高涨幅是价格触达研究指标而非可成交收益。

#### Scenario: Curve graduation evidence is incomplete
- **WHEN** 曲线信号在 T+1h 前没有 completed 事件，且 T+1h 附近也没有新鲜 Trenches 生命周期数据
- **THEN** 系统将毕业状态标记为 unknown、从毕业率分母排除并降低对应覆盖率

#### Scenario: Detailed source report is generated
- **WHEN** 请求详细统计
- **THEN** 系统按曲线加速、1m 极速突破、跨来源启动和双榜确认展示样本量、命中率、中位 MFE/MAE 与平均延迟
