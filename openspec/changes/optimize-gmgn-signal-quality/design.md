## Context

See `proposal.md` for motivation. The current runtime rotates three GMGN sources at one-second cadence, persists only changed rows, keeps a 60-second token event window, and runs a pure detector over those events. Rank requests already default to 100 but duplicate the configured value and apply three upstream filters. Security is candidate-scoped, Pool Info is available, research samples are bounded to five per minute, and real signals are unique per token lifecycle.

## Goals / Non-Goals

**Goals:**

- Restore authoritative 1m/5m presence without increasing snapshot database write volume.
- Add mature-token coverage and reduce impossible rank gates with a small number of explicit booleans.
- Prevent graduated delivery on stale or absent liquidity and make thin Early opportunities visibly distinct.
- Preserve deterministic replay and cumulative outcome evaluation.

**Non-Goals:**

- No weighted scoring, machine learning, new market provider, Solana support, trade execution, or automatic threshold tuning.
- No automatic promotion of Mature research to live delivery.
- No requirement that GMGN return exactly 100 rows when its filtered result is shorter.

## Decisions

### Keep a latest-source map beside the event window

Each successful rank or Trenches commit replaces an in-memory map of the complete current response. The event window continues receiving only real enter/update/exit events and remains the sole momentum source. Detector input gains explicit current values; replay reconstructs the same current map from source batches, preserving determinism. Persisting every unchanged Top100 row was rejected because it would inflate SQLite and create false momentum.

### Use the configured rank limit and one upstream prefilter

The poller passes `rank.limit` to the client and the request serializes only `not_honeypot`. Candidate-scoped Security remains authoritative. Fetching the raw unfiltered list was rejected for V2 because it would add avoidable honeypot preheating; retaining `verified` and `renounced` was rejected because production responses demonstrate materially reduced 1m coverage before detector evaluation.

### Add one detector trigger and reuse research persistence

`mature_momentum` is a pure detector trigger with explicit age, liquidity, rank, buy-pressure, and sustained-strength gates. Runtime configuration defaults it to research-only. Existing research tables store its feature snapshot and outcomes; signal tables need no new column because trigger and move class remain in decision JSON. This avoids a schema migration and a separate shadow pipeline.

### Treat liquidity by lifecycle

Graduated candidates receive a fresh Pool Info lookup in the final delivery recheck. Curve candidates use fresh Trenches liquidity because a migrated DEX pool may not exist yet. Positive liquidity is mandatory. The 5,000 USD boundary changes only the public/actionability class; it does not silently discard an otherwise safe early opportunity.

### Confirm persistence rather than additional acceleration

Confirmation compares fresh observations with the qualification reference, permits high-ranked tokens to confirm, and rejects a fallback greater than five places. This keeps confirmation meaningful without requiring mathematically impossible improvement from Top5.

### Keep presentation and statistics derived

Age and liquidity are copied into the card model from current normalized market data. Signal category is derived from trigger, lifecycle, liquidity class, and move class. Existing outcomes remain unchanged; grouped views compute separate denominators without rewriting historical records.

## Risks / Trade-offs

- [Relaxed rank gates increase candidate volume] → Preserve buy/activity/security/noise gates and compare cumulative V2 outcomes by config version.
- [Removing two upstream filters increases Security work] → Keep Top30 preheating, cache Security for 60 seconds, and use the existing bounded concurrency/weighted limiter.
- [Mature rules have weak historical evidence] → Keep the path research-only until 30 valid T+1h samples and require explicit enablement.
- [A thin Early observation can still rug] → Require positive fresh liquidity, label it high risk, separate its statistics, and retain post-signal removal monitoring.
- [Current state is lost on restart] → Rebuild it from the first successful source baselines before enabling triggers; no persistent migration is required.

## Migration Plan

1. Deploy code and configuration as a new config version with Mature delivery disabled.
2. On startup, wait for successful Trenches, 1m, and 5m baselines; do not trigger from baseline rows alone.
3. Verify request/schema/rate-limit health, Top100 coverage, Telegram rendering, and Pool Info rejection paths in Shadow.
4. Accumulate Early outcomes and Mature research outcomes by sample count.
5. Roll back by redeploying the prior image/config; SQLite changes are backward compatible because no migration is introduced.
