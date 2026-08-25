## Why

Production evidence shows that GMGN requests can remain queued before HTTP timeout, leaving all realtime pollers permanently in-flight while the container stays alive. During the healthy period, candidates were also cancelled immediately because delivery recheck required the original short momentum trigger to fire again and treated unchanged Curve counters as stopped momentum, resulting in zero Telegram signals despite 103 detected candidates.

## What Changes

- Replace the contended token acquisition loop with a small starvation-free priority queue: realtime market sources first, Security second, offline outcome work last.
- Bound queue waiting and add a source-liveness watchdog that exits cleanly when any required market source has not succeeded for thirty seconds, allowing Docker restart policy to recover the process.
- Recheck an already-qualified candidate using current safety, presence, fallback, buy-pressure, and liquidity conditions without requiring the original 10-second momentum event to trigger again.
- Stop treating unchanged Curve cumulative fields immediately after qualification as lost momentum; cancel only on actual regression or existing explicit safety/liquidity failures.
- Add focused concurrency, watchdog, recheck, and regression tests plus operator diagnostics. Do not alter Fast/Cross thresholds or enable Mature live delivery.

## Capabilities

### New Capabilities

- `gmgn-pipeline-liveness`: Defines starvation-free API scheduling, bounded in-flight recovery, and continuation-based final delivery checks.

### Modified Capabilities

None.

## Impact

Affected areas are the local GMGN weighted limiter, realtime scheduler/health supervision, detector continuation rules, runtime delivery recheck, tests, and operator documentation. GMGN and Telegram API contracts, SQLite schema, deployment secrets, signal thresholds, and Mature activation remain unchanged.
