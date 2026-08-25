## Purpose

Improve BSC signal coverage and followability while preserving a small GMGN-only architecture, deterministic rules, cumulative evaluation, and conservative fail-closed delivery.

## ADDED Requirements

### Requirement: Maximum ranking coverage with authoritative current state
The system SHALL request the configured maximum of 100 entries from both GMGN 1m and 5m ranking endpoints using only the `not_honeypot` ranking prefilter. It SHALL maintain the latest complete successful response as current source state separately from persisted change events, and SHALL use current state for source presence while using genuine changes for momentum.

#### Scenario: Unchanged ranked token remains present
- **WHEN** a token remains unchanged in a successful 5m Top100 response for longer than the change-event retention window
- **THEN** the detector still treats the token as currently present in the 5m ranking but does not manufacture a momentum event

#### Scenario: Filtered source returns fewer than one hundred tokens
- **WHEN** GMGN returns fewer than 100 valid entries after the supported prefilter
- **THEN** the system accepts the complete returned set without padding, local truncation, or treating the short response as failure

### Requirement: Calibrated Early and cross-source triggers
The system SHALL use deterministic boolean gates rather than a weighted score. Fast Rank SHALL require current 1m Top10 and at least eight places of improvement in ten seconds. Cross Source SHALL require current 1m Top30, current 5m Top80, and at least five places of 1m improvement in ten seconds. Existing buy-pressure, holder, swap, Trenches, smart-money, security, cancellation, and noise requirements SHALL remain in force unless explicitly superseded here.

#### Scenario: Moderate fast-rank acceleration qualifies
- **WHEN** a safe token improves from rank 17 to rank 9 within ten seconds and satisfies all remaining Fast Rank gates
- **THEN** it becomes an Early candidate without needing a fifteen-place jump

#### Scenario: Weak movement remains observing
- **WHEN** a token improves fewer than the required places or loses buy pressure
- **THEN** it remains observing and does not qualify merely because it is highly ranked

### Requirement: Sustained double-ranking confirmation
The system SHALL confirm a sent ranked signal from two fresh 1m and 5m observations that remain inside 1m Top30 and 5m Top50, retain buy pressure, do not fall more than five 1m places from qualification, and show holder or swap growth. Confirmation SHALL NOT require an additional fixed five-place 1m and three-place 5m improvement.

#### Scenario: Top-five signal can confirm by sustaining strength
- **WHEN** a signal qualified inside the 1m Top5 and two fresh observations remain within the confirmation ranks with buy pressure and activity growth
- **THEN** the original Telegram message is confirmed even though further five-place improvement is impossible

### Requirement: Mature momentum research path
The system SHALL evaluate a separate Mature path for tokens at least one hour old with liquidity of at least 30,000 USD, current 1m Top20, current 5m Top40, and buy pressure. It SHALL qualify when the token either improves at least three 1m places within sixty seconds or sustains 1m Top10 strength without material fallback. Mature candidates SHALL remain research-only until at least 30 valid T+1h Mature outcomes exist and live delivery is explicitly enabled.

#### Scenario: Mature token is sampled without delivery
- **WHEN** a two-hour-old safe token satisfies the Mature gates while Mature delivery is disabled
- **THEN** the system stores a bounded Mature research sample and sends no Telegram signal

#### Scenario: New token does not enter Mature path
- **WHEN** a token is less than one hour old
- **THEN** it is evaluated only by the existing curve and Early paths

### Requirement: Fresh liquidity evidence before delivery
The system SHALL fail closed when current positive liquidity cannot be established immediately before Telegram delivery. Graduated candidates SHALL use a Pool Info response no older than ten seconds and reject missing, removed, or zero-liquidity pools. Curve candidates SHALL use fresh Trenches liquidity evidence. An Early candidate below 5,000 USD liquidity SHALL be delivered only as an observation-only high-risk signal, not as an ordinary entry signal.

#### Scenario: Removed graduated pool blocks delivery
- **WHEN** the latest Pool Info check shows no active pool or zero liquidity for a qualified graduated token
- **THEN** the candidate is cancelled before Telegram delivery with a non-secret diagnostic reason

#### Scenario: Thin Early pool is labeled observation-only
- **WHEN** a safe Early candidate has positive liquidity below 5,000 USD at send time
- **THEN** its public card is explicitly labeled high-risk observation and it is excluded from ordinary-entry quality statistics

### Requirement: Concise public context and separated quality reporting
Signal cards SHALL show signal type, token age, liquidity, price, market capitalization, 1m/5m ranks when available, and a concise risk label without internal thresholds, formulas, scores, or raw security fields. Statistics SHALL separate ordinary Early signals, high-risk observations, and Mature research, retain cumulative fixed-multiple and drawdown metrics, and expose time since last signal plus recent observing, rejection, cancellation, suppression, and source-failure counts in detailed diagnostics.

#### Scenario: Public card omits detector internals
- **WHEN** an Early or Mature signal card is rendered
- **THEN** the card contains concise market and risk context but no rank-improvement threshold, formula, score, or internal decision JSON

#### Scenario: Sample-based Mature progress is visible
- **WHEN** the operator requests detailed statistics
- **THEN** the response shows Mature valid sample progress toward 30 separately from real-signal denominators
