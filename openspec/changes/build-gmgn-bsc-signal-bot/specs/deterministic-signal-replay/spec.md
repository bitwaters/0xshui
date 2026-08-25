## Purpose

定义实时事件的最小持久化与确定性回放行为，使阈值调整可以基于已采集的同一 GMGN 候选集合公平比较，并明确采样、上游过滤和历史范围限制。

## ADDED Requirements

### Requirement: Replayable event persistence
系统 SHALL 持久化 Trenches、1m Rank、5m Rank 的变化事件、Security 完成事件、候选拒绝/取消/限频原因、信号、结果和配置版本。快照与 Security SHALL 共享严格递增 `ingest_seq`。

#### Scenario: Asynchronous sources complete in the same second
- **WHEN** 多个来源或 Security 在相同时间戳附近完成
- **THEN** 系统以 `ingest_seq` 保留实际提交顺序，而不依赖时间戳猜测先后

### Requirement: Bounded sampling and retention
预热范围内的高频候选 SHALL 保存每个 `enter/update/exit`；普通榜单成员 SHALL 必存 `enter/exit` 且 update 最多每 5 秒保存一次。快照默认保留 14 天，信号、结果和配置版本默认保留 180 天；数据库达到 5 GB 软上限时 SHALL 优先清理最旧普通快照，再清理过期高频快照，不删除未到期信号与结果。

#### Scenario: SQLite reaches its soft size limit
- **WHEN** 数据库超过 5 GB 软上限
- **THEN** 系统按保留优先级清理快照、执行 checkpoint 和增量回收，并保留有效期内信号及结果

### Requirement: Deterministic detector replay
回算 SHALL 按 `ingest_seq` 合并播放来源和 Security 事件，使用与实时相同的纯检测规则和指定 `config_version`。同一来源批次内候选 SHALL 按 `token_key` 固定排序，`exit` 排名 SHALL 按 101 处理，回放 MUST NOT 读取当前事件之后的数据。

#### Scenario: Replay is repeated with identical inputs
- **WHEN** 使用相同事件集、适配版本和配置版本执行两次回算
- **THEN** 两次产生完全相同的候选、信号、抑制原因和统计结果

#### Scenario: Parameter set changes
- **WHEN** 使用新的配置版本回放同一历史事件集
- **THEN** 系统只改变参数允许影响的检测结果，不重新请求或混入未来 GMGN 数据

### Requirement: Replay scope disclosure
每份回算结果 SHALL 标注 `upstream_filter_version`、`adapter_version` 和 `sampling_level`，并说明结果只覆盖已保存的 GMGN 上游过滤后候选；普通榜单历史精度为 5 秒，无法评估被上游过滤掉的代币或更宽松的上游安全条件。

#### Scenario: Replay report is produced
- **WHEN** 参数回算完成
- **THEN** 报告包含范围和版本标记，以及候选数、信号数、各类过滤/取消/抑制数、命中率、毕业率、MFE、MAE 和延迟对比

### Requirement: Storage failure safety
系统 SHALL 在无法持久化信号幂等状态时停止发送新 Telegram 信号，但可以继续轮询市场以便恢复后补充快照。

#### Scenario: SQLite write fails before delivery
- **WHEN** 新信号状态无法可靠写入数据库
- **THEN** 系统不发送该信号，记录存储故障并保持市场采集可恢复运行
