# GMGN BSC Signal Bot

A BSC-only Telegram signal bot that uses GMGN OpenAPI for market discovery and safety data. V1 sends signals and measures their outcomes; it does not hold a wallet, sign transactions, or trade.

## Requirements

- Node.js 22 and npm 10
- A GMGN API key
- A Telegram bot token and destination chat only when `telegram.enabled=true`

## Setup

```bash
npm ci
cp .env.example .env
```

Set `GMGN_API_KEY` in `.env`. The committed `config/default.yaml` starts in `shadow` mode with Telegram disabled. Keep secrets out of YAML, SQLite, logs, shell history, and source control. V1 intentionally has no `GMGN_PRIVATE_KEY` setting.

Run the local checks:

```bash
npm run check
```

Build and start:

```bash
npm run build
GMGN_API_KEY=... npm start
```

The single-process runtime is fully wired. Formal-channel activation remains blocked until the measured shadow acceptance gates pass and an operator explicitly approves the current detection/safety parameter fingerprint.

## Modes

- `shadow`: runs the production detector rules and may send matching signals immediately to a private development channel when `telegram.enabled=true`.
- `production`: requires `telegram.enabled=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. Formal-channel activation remains blocked until the current configuration passes the sample, coverage, latency, and API-quality gates.

Use a separate production YAML file and set `APP_CONFIG_PATH`; do not edit secrets into configuration files.

## Database operations

The default database path is `data/signals.sqlite`.

- Stop the process cleanly before a manual file backup.
- Copy the SQLite database together with any `-wal` and `-shm` files, or use SQLite's online `.backup` command.
- Restore only while the bot is stopped, and keep the pre-restore files until startup and integrity checks pass.
- Run `npm run migrate` before starting a newly deployed application version.

## Replay

Replay reads stored events, compact research samples, and a selected configuration version. It never calls GMGN or Telegram:

```bash
npm run replay -- --config-version 1 --from 2026-08-01T00:00:00Z --to 2026-08-02T00:00:00Z
```

`--config-version` defaults to the latest stored version. `--from` and `--to` accept Unix milliseconds or ISO timestamps; the default range is the configured snapshot-retention window. The JSON report includes source/adapter/sampling versions, replay decisions, actual final-state counts, outcome quality, coverage, and scope limitations. Narrow the range if incompatible source or adapter versions are present.

## Shadow acceptance

Create one local configuration for the private channel; do not edit or duplicate the committed defaults in source control:

```bash
cp config/default.yaml config/local.yaml
```

In the ignored `config/local.yaml`, keep `mode: shadow` and change only `telegram.enabled` to `true`. In the ignored `.env`, set `GMGN_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `APP_CONFIG_PATH=config/local.yaml`. Never use the future production Chat ID during this run.

Start the same single process. Matching real signals are sent immediately to the private channel while samples accumulate:

```bash
npm run migrate
npm start
```

Inspect the measured gates from the same directory and database:

```bash
npm run acceptance
```

Acceptance is sample-based, not time-based. The current configuration needs at least 100 valid T+1h signal outcomes, at least 20 from each of the three trigger paths, at least 90% T+1h outcome coverage, enough latency observations, 10,000 GMGN requests with at least 99% success, and no uncontrolled 429 or critical schema failure. Review signal quality at 30 samples, establish the first baseline at 100, then review every additional 50 samples.

Security-passed preheat candidates are also stored as a compact research cohort, capped at five per rolling minute. Their 15m/1h outcomes support later parameter replay but never count as Telegram signals or acceptance samples. If the SQLite soft limit is reached after ordinary snapshots are pruned, the oldest auxiliary research samples are removed before any real signal result.

## Docker Compose deployment

The committed Compose file runs the default `shadow` configuration, enables Telegram through the validated `TELEGRAM_ENABLED=true` deployment override, and persists SQLite in the `signal-data` volume. Only `.env` contains deployment secrets and it is excluded from both Git and the Docker build context.

```bash
cp .env.example .env
# Fill GMGN_API_KEY, TELEGRAM_BOT_TOKEN, and the private TELEGRAM_CHAT_ID.
docker compose config --quiet
docker compose up -d --build
docker compose logs --tail=100 bot
```

Deploy code changes only by pushing them to GitHub and pulling them into the deployment directory before running Compose again. Do not edit application source on the server.

The command exits with status 2 while sample count, per-path count, coverage, request quality, rate-limit stability, or P95 latency gates are incomplete. Once all gates pass, approve only the current detection/safety parameter fingerprint:

```bash
npm run acceptance -- --approve
```

Use `npm run acceptance -- --reject` to revoke approval. `production` startup fails closed unless the current fingerprint is approved. Signal configuration versions deliberately ignore only `mode` and `telegram.enabled`, so switching from private Shadow delivery to Production preserves the accumulated sample set. Changing detection, safety, noise, polling, or outcome parameters creates a new version and restarts acceptance sampling.

## Safe shutdown

Send `SIGTERM` or `SIGINT` and allow the process to close its scheduler and SQLite connection. Do not use `kill -9` except when the process cannot shut down, because a forced stop can leave an ambiguous Telegram delivery that must fail closed on restart.
