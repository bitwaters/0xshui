## Purpose

保证 GMGN 实时采集在离线研究任务并发、请求排队或单个轮询卡住时仍能持续获取 BSC 榜单，并让已经进入待推送阶段的候选按当前安全与市场状态复检，而不是被已经过期的首次触发窗口误取消。

## ADDED Requirements

### Requirement: Bounded priority request scheduling

The system SHALL schedule GMGN requests through one bounded priority queue ordered by realtime, security, then offline work, while preserving FIFO order within each priority. A queued request MUST either receive capacity or fail within the configured maximum queue wait; it MUST NOT wait indefinitely.

#### Scenario: Offline backlog cannot block realtime polling

- **WHEN** offline research requests are queued while realtime ranking or Trenches requests arrive
- **THEN** the realtime requests are selected before pending offline requests, subject only to an already active HTTP attempt or cooldown

#### Scenario: Equal-priority requests remain ordered

- **WHEN** multiple requests of the same priority are waiting for capacity
- **THEN** they are admitted in enqueue order without later lighter requests bypassing the queue head

#### Scenario: Queue wait is bounded

- **WHEN** a request cannot receive capacity before its queue deadline
- **THEN** the request fails with a queue-timeout error so its scheduler cycle can finish and retry later

### Requirement: Required-source liveness recovery

The runtime SHALL monitor successful responses for every required realtime GMGN source. If any required source has no successful response for 30 seconds after startup or its last success, the runtime MUST initiate the existing graceful shutdown path with a failure status so Docker Compose can restart the process.

#### Scenario: Successful but unchanged response refreshes liveness

- **WHEN** a required source returns a successful response containing no changed market rows
- **THEN** its liveness timestamp is refreshed because transport and parsing succeeded

#### Scenario: Stale source triggers graceful restart

- **WHEN** any required realtime source has no successful response for 30 seconds
- **THEN** the runtime records the stale source and exits through graceful shutdown with a failure status

### Requirement: Qualified candidates use continuation recheck

Immediately before Telegram delivery, the system SHALL re-evaluate an already qualified candidate using current source presence, security, liquidity, fallback, buy-pressure, and cancellation rules. The recheck MUST NOT require the original short-lived acceleration or rank-entry trigger to fire again.

#### Scenario: Original trigger expires but candidate remains valid

- **WHEN** a candidate qualified from a valid trigger and the original trigger window has expired before delivery
- **AND** current safety, liquidity, source presence, fallback, and buy-pressure rules still pass
- **THEN** the candidate remains qualified for delivery

#### Scenario: Current risk cancels delivery

- **WHEN** an already qualified candidate fails a current safety, liquidity, source-presence, fallback, or buy-pressure rule
- **THEN** delivery is cancelled with the current concrete reason

### Requirement: Unchanged curve evidence is not regression

The system SHALL treat unchanged cumulative Trenches progress, holder, swap, and net-buy evidence as neutral during delivery recheck. It MUST cancel for stopped curve momentum only when at least one required cumulative signal actually regresses or another current safety rule fails.

#### Scenario: Equal curve snapshot remains eligible

- **WHEN** current cumulative curve values equal the values captured at qualification
- **THEN** the system does not cancel solely for `curve_momentum_stopped`

#### Scenario: Curve evidence regresses

- **WHEN** at least one required cumulative curve value is lower than its qualification baseline
- **THEN** the system cancels delivery with `curve_momentum_stopped`
