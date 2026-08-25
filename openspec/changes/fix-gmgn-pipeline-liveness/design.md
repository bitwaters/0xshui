## Context

Production telemetry showed that all GMGN pollers could remain marked in-flight while request attempts fell to zero. The HTTP timeout did not help because requests were waiting inside the local weighted limiter before an HTTP attempt began. At the same time, qualified candidates were cancelled during Telegram's final recheck because the detector required the original short-lived trigger to fire again; unchanged cumulative curve values were also classified as stopped momentum.

The bot is intentionally a small BSC-only service. The repair must preserve its single-process, SQLite, Docker Compose architecture and must not add another queue service, scoring system, or strategy branch.

## Goals / Non-Goals

**Goals**

- Keep realtime GMGN polling responsive under offline research load.
- Ensure every queued limiter request settles within a bounded time.
- Recover automatically if a required market source stops succeeding.
- Recheck qualified signals against current tradability and risk without replaying the original entry trigger.
- Preserve the current Fast, Cross, Curve, and Mature policy configuration.

**Non-Goals**

- Changing signal thresholds, ranking depth, or cooldown policy.
- Enabling Mature live delivery.
- Adding Redis, a message broker, worker processes, or external monitoring infrastructure.
- Changing the database schema or Telegram card format.

## Decisions

### One in-process priority FIFO dispatcher

Replace independent token-acquisition loops with one in-memory dispatcher. Requests carry their existing path-derived priority and weight. The dispatcher selects realtime before security before offline and preserves FIFO order within a priority, including head-of-line waiting for a heavier request. A single timer wakes the dispatcher when tokens, cooldown expiry, or the next queue deadline can change the outcome.

Every queue item has a maximum wait. Timeout rejects the request and lets the scheduler clear its in-flight flag. This bounded failure is preferable to an invisible permanent stall and also bounds strict-priority starvation without introducing aging weights or a second scheduling algorithm.

### Runtime watchdog over successful source callbacks

Add a small source-liveness watchdog initialized at runtime startup. Existing poller success callbacks refresh it even when source data is unchanged. A five-second check identifies any required source older than 30 seconds and requests the existing graceful shutdown path with a non-zero exit status. Docker Compose's restart policy provides process recovery.

The watchdog observes only required realtime market sources. Security and offline research requests are not independent market feeds and therefore do not trigger restarts.

### Continuation semantics for qualified state

Allow a stored candidate to supply its original trigger identity while the state is `qualified`, just as it already does while waiting for security. All current cancellation, source-freshness, safety, liquidity, fallback, buy-pressure, and noise checks still run. Only the requirement to reproduce the original acceleration/rank-entry event is removed.

This keeps one detector path and avoids a second parallel delivery policy. It also means retries remain deterministic from the same persisted candidate evidence plus current snapshots.

### Strict regression for cumulative curve evidence

Change the curve cancellation comparison from “all current values are less than or equal to baseline” to “at least one required cumulative value is lower than baseline.” Equality is expected when security and Telegram checks complete before another Trenches update and is not evidence of deterioration.

## Risks / Trade-offs

- Strict priority can delay offline research during sustained realtime pressure. The queue deadline bounds that delay; offline jobs already retry and do not affect live delivery.
- A 30-second watchdog can restart during a prolonged upstream outage. That is intentional fail-fast recovery; restart loops remain visible in Docker logs and no Telegram message is sent without fresh data.
- Continuation recheck may allow delivery after the original momentum burst ends. Current buy-pressure, ranking presence, fallback, liquidity, and safety checks still fail closed, so this removes a timing race rather than bypassing quality filters.
- Head-of-line FIFO may leave a small token balance unused while a heavier earlier request waits. This is accepted to prevent lighter requests from repeatedly starving Trenches polling.

## Migration Plan

No schema or data migration is required. Deploy the application image through the existing local commit, GitHub push, server pull, and Docker Compose rebuild flow. Verify source freshness, limiter queue depth, restart behavior tests, and signal cancellation reasons after deployment. Rollback is the previous application commit and image rebuild; persisted candidate rows remain compatible.
