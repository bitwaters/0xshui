# GMGN fixture provenance

These compact fixtures were captured from BSC read-only responses on 2026-08-24
using GMGN OpenAPI and `gmgn-cli` 1.5.6, then reduced and replaced with synthetic
addresses and names. They intentionally retain observed envelope and field types.

- Rank used a two-layer success envelope.
- Trenches, Security, Kline, and Pool used one-layer success envelopes.
- Current Trenches returned `near_completion`; `pump` is retained as the documented
  historical alias.
- A 2026-08-25 live verification observed Rank using `creation_timestamp=0` for an
  unknown optional value and one token overlapping `new_creation`/`near_completion`;
  compact synthetic contract tests preserve both compatibility cases.
- The 2026-08-25 ranking contract requests up to 100 rows with only the
  `not_honeypot` upstream filter; local safety rules remain the final gate.
- Security returned mixed booleans, `0/1`, and decimal strings.
- `invalid-security-single.json` records the observed HTTP-200/code-0 response for
  an invalid address; its empty critical fields must still fail closed.
- `rate-limit.json` follows the current official 429 body contract.

No API keys, authentication query values, private keys, or user data are stored.
