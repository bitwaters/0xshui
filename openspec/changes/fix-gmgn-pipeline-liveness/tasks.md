## 1. Request pipeline liveness

- [x] 1.1 Replace independent token acquisition with a bounded priority FIFO dispatcher while preserving cooldown and recovery behavior
- [x] 1.2 Add limiter tests for realtime priority, same-priority FIFO, heavy-request head-of-line fairness, and queue timeout
- [x] 1.3 Add a required-source liveness watchdog and connect it to poller success plus graceful runtime shutdown
- [x] 1.4 Add watchdog unit tests for startup grace, unchanged-response refresh, and stale-source detection

## 2. Delivery recheck correctness

- [x] 2.1 Allow qualified candidates to use continuation evidence without reproducing the original short-lived trigger
- [x] 2.2 Treat equal cumulative curve evidence as neutral and cancel only on actual regression
- [x] 2.3 Add detector and signal-engine regression tests for continuation delivery and current-risk cancellation

## 3. Verification and deployment guidance

- [x] 3.1 Update operational documentation for bounded limiter waits, the 30-second watchdog, and continuation recheck semantics
- [x] 3.2 Run focused and full automated test suites, typecheck/build, and strict OpenSpec validation
- [x] 3.3 Review the completed change for regressions and confirm no thresholds, Mature delivery, schema, or secrets changed
