## 1. Project Foundation

- [x] 1.1 Initialize the Node.js 22 TypeScript strict project with npm/package-lock and lint, typecheck, test, build, migration, replay, and start scripts
- [x] 1.2 Add and pin the minimal runtime dependencies for Zod, grammY, better-sqlite3, Pino, YAML parsing, and environment loading
- [x] 1.3 Define the validated V1 configuration schema and defaults for BSC, polling, GMGN, risk thresholds, noise limits, outcomes, retention, and shadow mode
- [x] 1.4 Implement startup credential checks for GMGN API key, Telegram token, and target chat without logging secret values
- [x] 1.5 Implement structured logging, correlation IDs, secret redaction, metadata truncation, and the documented operational event names
- [x] 1.6 Add `.env.example` and concise operator documentation for setup, shadow/production modes, backup/restore, replay, and safe shutdown

## 2. SQLite Persistence

- [x] 2.1 Create migrations for token_snapshots, security_checks, signals, signal_outcomes, config_versions, and runtime_state with required indexes and uniqueness constraints
- [x] 2.2 Configure WAL, foreign keys, busy timeout, incremental auto-vacuum, and transactional allocation of the shared ingest_seq
- [x] 2.3 Implement parameterized repositories for atomic source batches, Security events, updateable unsent candidate decisions, unique signal delivery states, Telegram message IDs, outcomes, config versions, and runtime cooldown/report state
- [x] 2.4 Implement startup state recovery so sent tokens, message IDs, rolling limits, pending outcomes, GMGN cooldown, last daily report, and next ingest_seq survive restart, converting unresolved delivery_pending records to delivery_unknown
- [x] 2.5 Implement 14-day/180-day retention, 5 GB soft-limit priority cleanup, WAL checkpoint, and incremental vacuum with tests

## 3. GMGN Direct OpenAPI Integration

- [x] 3.1 Implement the singleton read-only GMGN HTTP client with Exist Auth, fresh timestamp/client_id, User-Agent, keep-alive, 5-second timeout, and 10 MB response cap
- [x] 3.2 Implement explicit one/two-layer response unwrapping, error classification, one network/5xx retry, and global 429 reset handling
- [x] 3.3 Implement Trenches, Rank, Token Security, Kline, and Pool request serialization without invoking or importing gmgn-cli in production code
- [x] 3.4 Capture sanitized current BSC fixtures for successful and failing responses, including single/double envelopes and known Trenches stage aliases
- [x] 3.5 Implement Zod adapters and internal models for all five endpoints, including strict BSC address, number, ratio, boolean, timestamp, and Kline conversions
- [x] 3.6 Add contract tests proving unknown envelopes, invalid critical fields, oversized bodies, non-success codes, and bad addresses fail closed
- [x] 3.7 Add a startup read-only Schema/Auth self-check and, when GMGN returns a Date header, a bounded clock-drift check that disables formal delivery on failure

## 4. Realtime Scheduling and Snapshots

- [x] 4.1 Implement the 1-second fixed source rotation with independent in-flight guards for Trenches, 1m Rank, and 5m Rank
- [x] 4.2 Implement the shared weighted limiter at 4 weight/s, charge retries, persist buffered 429 cooldown_until with a 5-minute invalid/missing-reset fallback, and stage recovery across realtime, Security, and offline priorities
- [x] 4.3 Implement per-source startup baselines and successful-response diffing into atomic enter/update/exit batches without creating exit events for failed polls
- [x] 4.4 Implement the per-token in-memory 60-second/10-snapshot window, 10-second source freshness checks, and rank-null-as-101 behavior
- [x] 4.5 Implement candidate-scoped Security preheating, concurrency control, 60-second cache, 10-second send-age refresh, and cold-start protection
- [x] 4.6 Add scheduler and snapshot tests for overlapping requests, identical responses, source failures, stale data, exits, async ingest_seq ordering, invalid 429 reset metadata, and restart during cooldown

## 5. Detection and Safety

- [x] 5.1 Implement the pure, versioned detector input/output model and candidate lifecycle state machine without network or database side effects
- [x] 5.2 Implement the Bonding Curve acceleration path with cumulative-delta baseline reset and lifecycle-specific field requirements
- [x] 5.3 Implement the 1m fast-rank and cross-source startup paths with exact fresh-snapshot, ranking, buy/sell, holder, swap, and smart-money conditions
- [x] 5.4 Implement universal Security required fields, source-aware hard risk rejection, dangerous-value conflict resolution, graduated LP evidence, and curve-stage exceptions
- [x] 5.5 Implement the post-Security fallback cancellation rules and non-overlapping normal, fast-rise, and observation-only extreme-move boundaries
- [x] 5.6 Implement double-rank confirmation, direct high-priority confirmation, one-token lifecycle deduplication, fresh-event re-evaluation of unsent outcomes, valid-Creator cooldown, and 60-second global limits
- [x] 5.7 Add table-driven unit tests for every trigger boundary, missing-field policy, safety threshold, cancellation, priority, and noise-limit scenario

## 6. Telegram Delivery

- [x] 6.1 Implement escaped, length-bounded Bonding Curve and graduated signal view models that omit internal thresholds, formulas, weights, and scores
- [x] 6.2 Implement fixed GMGN/BscScan buttons and contract copy actions derived only from validated BSC addresses
- [x] 6.3 Implement an atomic single-winner transition into delivery_pending plus delivery_unknown, sent, and confirmed states with a unique token lifecycle and persistence of telegram_message_id
- [x] 6.4 Implement double-rank confirmation by editing the original message without consuming a first-signal quota
- [x] 6.5 Classify Telegram failures into definitively-not-accepted versus ambiguous, retry only the former up to three total attempts, and implement fresh market recheck plus telegram_delay_cancelled behavior
- [x] 6.6 Add rendering, hostile-metadata, concurrent-trigger, restart-deduplication, ambiguous-delivery, safe-retry, cancellation, and message-edit integration tests

## 7. Outcomes and Statistics

- [x] 7.1 Implement persistent T+15m and T+1h outcome jobs, maximum three retries, and terminal-state completion within the 10-minute grace window
- [x] 7.2 Implement 30-second candle boundary correction, last-completed-close checkpoint pricing, and calculations for 1m/5m/15m/1h returns plus 15m/1h MFE and MAE from sent_price
- [x] 7.3 Implement asynchronous graduated Pool baselines and Pool/Trenches-corroborated no_trade, pool_removed, api_missing, and retry_exhausted classifications without treating an empty Kline alone as a terminal market conclusion
- [x] 7.4 Implement the fixed 15m hit, 1h large-gain, sent-only denominator, 1h curve graduation, double-confirmation, coverage, median-default, and detailed average-latency aggregation rules
- [x] 7.5 Implement `/stats`, `/stats 7d`, `/stats 30d`, `/stats detail`, and timezone-aware once-per-day reports with restart deduplication, sample-size, and price-touch disclosures
- [x] 7.6 Add outcome and statistics tests for pending samples, no-trade, confirmed removal, missing API data, candle boundaries, medians, and denominator correctness

## 8. Deterministic Replay

- [x] 8.1 Implement high-frequency candidate and 5-second ordinary snapshot persistence while preserving every enter and exit event
- [x] 8.2 Implement the replay runner that merges snapshots and Security events by ingest_seq, fixes batch token ordering, and prohibits future-data access
- [x] 8.3 Reuse the production detector and selected config_version to generate candidate, rejection, cancellation, suppression, signal, and result comparisons
- [x] 8.4 Include upstream_filter_version, adapter_version, sampling_level, scope limitations, and all required quality metrics in replay reports
- [x] 8.5 Add golden-fixture tests proving identical inputs are deterministic and parameter changes do not mutate or refetch historical data

## 9. Operational Acceptance

- [x] 9.1 Add health/readiness behavior and degradation tests for GMGN source failure, stale data, Security failure, Telegram failure, and SQLite write failure
- [x] 9.2 Add automated acceptance checks proving production code contains no gmgn-cli subprocess use, deep gmgn-cli imports, private-key reads, X-Signature generation, or automatic retry after ambiguous Telegram delivery
- [x] 9.3 Persist source-captured, qualified, Security-completed, Telegram-attempted, and Telegram-sent timestamps and export the required P50/P95, queue, cooldown, signal, rejection, and coverage metrics
- [x] 9.4 Run the complete unit, contract, integration, typecheck, lint, migration, restart, and deterministic replay suites on a clean workspace
- [x] 9.5 Replace duration-based acceptance with config-version-scoped gates for 100 valid T+1h samples, 20 samples per trigger path, 90% coverage, 30 latency samples, 10,000 GMGN requests at 99% success, and zero uncontrolled 429 or critical Schema failures
- [x] 9.6 Make private Shadow Telegram delivery immediate under the production detector rules and make `/stats` show cumulative current-config sample progress at 30, 100, and each additional 50 valid samples
- [x] 9.7 Persist at most five compact Security-passed preheat research samples per minute with low-priority 15m/1h outcomes, keep them separate from real signals, and include their bounded quality in deterministic replay
- [ ] 9.8 Run full validation and review, deploy through GitHub pull and Docker Compose, and verify real private-channel delivery readiness plus request/schema/rate-limit health without a duration gate
