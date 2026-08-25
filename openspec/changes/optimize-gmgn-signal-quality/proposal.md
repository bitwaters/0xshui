## Why

Production evidence shows that the current detector over-selects very young, low-liquidity tokens, misses sustained mature-token momentum, and can remain silent for unusually long periods because 10-second rank-improvement gates are too strict. The ranking ingestion also conflates current source presence with changed events, so unchanged tokens can disappear from detector context even while GMGN still lists them.

## What Changes

- Request the configured maximum of 100 entries for both 1m and 5m rankings, reduce ranking-request prefilters to `not_honeypot`, and validate the response contract without exposing credentials.
- Maintain a current in-memory ranking state separately from persisted rank-change events so detector presence checks always use the latest successful response while momentum remains change-based.
- Relax early fast-rank improvement from 15 to 8 places and cross-source improvement from 10 to 5 places while retaining buy-pressure and activity gates.
- Replace mandatory post-signal rank acceleration with sustained double-ranking confirmation.
- Add a simple mature-momentum shadow path for tokens at least one hour old with sufficient liquidity and sustained 1m/5m strength; it remains research-only until at least 30 valid T+1h samples are available.
- Require fresh positive-liquidity evidence before delivery: graduated candidates use Pool Info while curve candidates use current Trenches data. Missing, removed, or zero-liquidity evidence fails closed, and sub-$5,000 early candidates are classified as observation-only instead of ordinary entry signals.
- Add token age, liquidity, and concise signal type/risk labels to Telegram cards without exposing internal thresholds.
- Report Early and Mature research quality separately and include no-signal decision diagnostics, using cumulative sample gates rather than elapsed-time acceptance.

## Capabilities

### New Capabilities

- `gmgn-signal-quality`: Defines complete Top100 ranking coverage, current-state-aware detection, Early and Mature signal paths, fresh liquidity validation, concise delivery labels, and cumulative quality diagnostics.

### Modified Capabilities

None.

## Impact

The change affects GMGN ranking request serialization, realtime snapshot state, detector configuration and rules, pre-delivery Pool Info checks, Telegram card models, statistics/research summaries, tests, replay compatibility, and operator documentation. It introduces no new external API, chain, database service, scoring model, or trading integration.
