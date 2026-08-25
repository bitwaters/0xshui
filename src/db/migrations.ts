export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_persistence",
    sql: `
      CREATE TABLE config_versions (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        content_hash TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE token_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_seq INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('trenches', 'rank_1m', 'rank_5m')),
        event_type TEXT NOT NULL CHECK (event_type IN ('enter', 'update', 'exit')),
        token_key TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        source_captured_at INTEGER NOT NULL,
        sampling_level TEXT NOT NULL CHECK (sampling_level IN ('high', 'ordinary')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        upstream_filter_version TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        UNIQUE (ingest_seq, source, token_key)
      ) STRICT;

      CREATE INDEX idx_token_snapshots_replay
        ON token_snapshots (ingest_seq, source, token_key);
      CREATE INDEX idx_token_snapshots_token_time
        ON token_snapshots (token_key, captured_at);
      CREATE INDEX idx_token_snapshots_retention
        ON token_snapshots (sampling_level, captured_at, id);

      CREATE TABLE security_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_seq INTEGER NOT NULL UNIQUE,
        token_key TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('passed', 'rejected', 'failed')),
        reason TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        adapter_version TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_security_checks_token_time
        ON security_checks (token_key, captured_at);

      CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_key TEXT NOT NULL UNIQUE,
        creator_address TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('curve', 'graduated')),
        state TEXT NOT NULL CHECK (state IN (
          'observing', 'security_pending', 'qualified', 'rejected', 'cancelled',
          'suppressed', 'delivery_pending', 'delivery_unknown', 'sent', 'confirmed'
        )),
        reason TEXT,
        priority TEXT NOT NULL CHECK (priority IN ('normal', 'high')),
        config_version INTEGER NOT NULL REFERENCES config_versions(version),
        decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
        first_discovered_at INTEGER NOT NULL,
        qualified_at INTEGER,
        security_completed_at INTEGER,
        delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
        telegram_message_id INTEGER,
        sent_at INTEGER,
        sent_price REAL,
        sent_market_cap REAL,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (telegram_message_id IS NULL OR telegram_message_id > 0),
        CHECK (
          state NOT IN ('sent', 'confirmed')
          OR (telegram_message_id IS NOT NULL AND sent_at IS NOT NULL)
        ),
        CHECK (state != 'confirmed' OR confirmed_at IS NOT NULL),
        CHECK (state != 'delivery_pending' OR telegram_message_id IS NULL)
      ) STRICT;

      CREATE INDEX idx_signals_state_time ON signals (state, updated_at);
      CREATE INDEX idx_signals_creator_sent ON signals (creator_address, sent_at);

      CREATE TABLE signal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
        checkpoint_ms INTEGER NOT NULL CHECK (checkpoint_ms > 0),
        due_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'completed', 'no_trade', 'pool_removed', 'api_missing',
          'retry_exhausted'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
        next_attempt_at INTEGER,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (signal_id, checkpoint_ms)
      ) STRICT;

      CREATE INDEX idx_signal_outcomes_pending
        ON signal_outcomes (state, next_attempt_at, due_at);

      CREATE TABLE runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO runtime_state (key, value_json, updated_at)
      VALUES ('next_ingest_seq', '1', 0);
    `,
  },
  {
    version: 2,
    name: "outcome_pool_baseline",
    sql: `
      ALTER TABLE signals
      ADD COLUMN pool_baseline_json TEXT
        CHECK (pool_baseline_json IS NULL OR json_valid(pool_baseline_json));
    `,
  },
  {
    version: 3,
    name: "telegram_attempt_timestamp",
    sql: `
      ALTER TABLE signals
      ADD COLUMN telegram_attempted_at INTEGER;
    `,
  },
  {
    version: 4,
    name: "research_samples",
    sql: `
      CREATE TABLE research_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_key TEXT NOT NULL,
        config_version INTEGER NOT NULL REFERENCES config_versions(version),
        sampled_at INTEGER NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('curve', 'graduated')),
        baseline_price REAL NOT NULL CHECK (baseline_price > 0),
        feature_json TEXT NOT NULL CHECK (json_valid(feature_json)),
        detector_version TEXT NOT NULL,
        upstream_filter_version TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (token_key, config_version)
      ) STRICT;

      CREATE INDEX idx_research_samples_config_time
        ON research_samples (config_version, sampled_at, id);
      CREATE INDEX idx_research_samples_retention
        ON research_samples (sampled_at, id);

      CREATE TABLE research_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        research_sample_id INTEGER NOT NULL REFERENCES research_samples(id) ON DELETE CASCADE,
        checkpoint_ms INTEGER NOT NULL CHECK (checkpoint_ms > 0),
        due_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'completed', 'no_trade', 'pool_removed', 'api_missing',
          'retry_exhausted'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
        next_attempt_at INTEGER,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (research_sample_id, checkpoint_ms)
      ) STRICT;

      CREATE INDEX idx_research_outcomes_pending
        ON research_outcomes (state, next_attempt_at, due_at);
    `,
  },
] as const;
