## Purpose

定义 Telegram 用户实际看到的信号与统计交互，确保消息简洁、持久化去重、可安全展示不可信代币元数据，并在网络延迟或确认增强时保持一致。

## ADDED Requirements

### Requirement: Concise signal card
系统 SHALL 只向用户展示代币、阶段、价格或市值、当前排名/热度、关键动量摘要、GMGN 风险筛选结论、波动提示、合约地址和必要链接。消息 MUST NOT 展示内部阈值、公式、API 权重、缓存、快照数量或综合分。

#### Scenario: A first signal is delivered
- **WHEN** 候选通过最终检测与安全门槛
- **THEN** 用户收到一张不暴露内部参数的简洁信号卡片

### Requirement: Accurate risk wording
系统 SHALL 使用“GMGN 风险筛选通过”等有限结论，不得将 API 检查描述为“绝对安全”或保证未来不会 Rug。观察型和快速拉升信号 SHALL 明确提示价格已经偏离首次发现位置。

#### Scenario: Risk checks pass
- **WHEN** 候选通过所有 V1 硬安全规则
- **THEN** 卡片说明风险筛选通过，同时保留 Meme 代币高风险提示

### Requirement: One message per token lifecycle
系统 SHALL 在调用 Telegram 前以原子条件更新持久化唯一合约记录为 `delivery_pending`，成功后保存 `telegram_message_id` 并进入 `sent`。`delivery_pending`、`delivery_unknown`、`sent` 和 `confirmed` SHALL 阻止并发或后续的再次首次发送。双榜确认 SHALL 编辑原消息；确认编辑不计入首次信号限额。系统 MUST NOT 宣称 Telegram 在模糊网络结果下提供 exactly-once 保证。

#### Scenario: Concurrent fresh events qualify the same token
- **WHEN** 两个来源事件几乎同时让同一合约满足发送条件
- **THEN** 只有一个执行者能够原子进入 `delivery_pending` 并调用 Telegram

#### Scenario: Delivery retry occurs after an uncertain response
- **WHEN** Telegram 请求失败且系统无法立即确认是否已发送
- **THEN** 系统将记录标记为 `delivery_unknown`、停止自动重试并阻止该合约再次首次发送，以漏发风险换取不主动制造重复消息

#### Scenario: Service restarts with a pending delivery
- **WHEN** 服务启动恢复到没有 `telegram_message_id` 的 `delivery_pending` 记录
- **THEN** 系统将其转换为 `delivery_unknown` 且不自动重试，因为无法证明崩溃发生在发送之前还是之后

#### Scenario: A sent signal becomes confirmed
- **WHEN** 已发送信号随后满足双榜确认
- **THEN** 系统将原卡片从首次状态更新为确认状态而不另发一条

### Requirement: Safe metadata and links
系统 SHALL 将 token name、symbol、社交资料及其他链上元数据视为攻击者可控文本，执行长度限制、转义和控制字符清理。交互按钮 SHALL 仅使用由合法 BSC 合约地址构造的固定 GMGN 与 BscScan 链接，并提供安全的地址复制能力。

#### Scenario: Token metadata contains markup or instructions
- **WHEN** 名称或符号包含 HTML、控制字符、超长文本或诱导性指令
- **THEN** 系统将其作为普通数据清理或截断，不执行、不解析为命令且不允许改变链接目标

### Requirement: Telegram failure handling
系统 SHALL 只对能够确认 Telegram 未接受消息的失败最多执行 3 次总尝试并使用指数退避，例如连接建立前失败或明确的 429。超时、请求发送后的连接中断或无法确定接受状态的 5xx SHALL 视为模糊结果并进入 `delivery_unknown`，不得自动重试。每次安全重试前 SHALL 重新检查价格与排名；若候选在等待期间严重回落，系统 SHALL 取消发送并记录 `telegram_delay_cancelled`。

#### Scenario: Signal fades during Telegram retries
- **WHEN** Telegram 连续失败且最新市场状态已命中回落取消条件
- **THEN** 系统停止重试，不发送过时信号并保存取消原因

#### Scenario: Telegram definitively rejects a request before acceptance
- **WHEN** 错误能够证明消息未被 Telegram 接受且候选仍有效
- **THEN** 系统在最多 3 次总尝试内按退避策略安全重试

### Requirement: Statistics commands and daily report
系统 SHALL 支持 `/stats`、`/stats 7d`、`/stats 30d` 和 `/stats detail`，并按配置报告时区每天最多发送一次统计。样本未完成评估时 SHALL 显示待评估数量和数据覆盖率，不得把它们计为失败。

#### Scenario: User requests default statistics
- **WHEN** 用户发送 `/stats`
- **THEN** 系统返回今日推送量、完成和待评估数量、15m/1h 命中指标、中位涨幅与回撤、曲线毕业率、双榜确认、延迟和覆盖率

#### Scenario: No signals have completed evaluation
- **WHEN** 日报时间到但当天没有已完成观察周期的样本
- **THEN** 系统显示“样本不足”而不输出误导性命中率

#### Scenario: Service restarts after today's report
- **WHEN** 服务在当天日报已经发送后重启
- **THEN** 系统从持久化状态恢复报告日期且不重复发送当日日报
