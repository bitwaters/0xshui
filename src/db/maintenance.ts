import { statSync } from "node:fs";

import type { SqliteDatabase } from "./database.js";

export interface MaintenanceOptions {
  readonly databasePath: string;
  readonly now: number;
  readonly snapshotRetentionMs: number;
  readonly signalRetentionMs: number;
  readonly softLimitBytes: number;
}

export interface MaintenanceResult {
  readonly ordinarySnapshotsDeleted: number;
  readonly highSnapshotsDeleted: number;
  readonly securityChecksDeleted: number;
  readonly signalsDeleted: number;
  readonly configVersionsDeleted: number;
  readonly sizeBeforeBytes: number;
  readonly sizeAfterBytes: number;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function totalDatabaseSize(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`) + fileSize(`${path}-shm`);
}

function logicalDatabaseSize(database: SqliteDatabase): number {
  const pageCount = database.pragma("page_count", { simple: true }) as number;
  const freePages = database.pragma("freelist_count", { simple: true }) as number;
  const pageSize = database.pragma("page_size", { simple: true }) as number;
  return (pageCount - freePages) * pageSize;
}

export function runDatabaseMaintenance(
  database: SqliteDatabase,
  options: MaintenanceOptions,
): MaintenanceResult {
  const snapshotCutoff = options.now - options.snapshotRetentionMs;
  const signalCutoff = options.now - options.signalRetentionMs;
  const sizeBeforeBytes = totalDatabaseSize(options.databasePath);

  let ordinarySnapshotsDeleted = database
    .prepare("DELETE FROM token_snapshots WHERE sampling_level = 'ordinary' AND captured_at < ?")
    .run(snapshotCutoff).changes;

  const securityChecksDeleted = database
    .prepare("DELETE FROM security_checks WHERE captured_at < ?")
    .run(snapshotCutoff).changes;

  const signalsDeleted = database
    .prepare("DELETE FROM signals WHERE updated_at < ? AND state != 'delivery_pending'")
    .run(signalCutoff).changes;

  const configVersionsDeleted = database
    .prepare(`
      DELETE FROM config_versions
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM signals WHERE signals.config_version = config_versions.version)
    `)
    .run(signalCutoff).changes;

  const deleteOrdinaryBatch = database.prepare(`
    DELETE FROM token_snapshots WHERE id IN (
      SELECT id FROM token_snapshots
      WHERE sampling_level = 'ordinary'
      ORDER BY captured_at, id LIMIT 1000
    )
  `);
  while (logicalDatabaseSize(database) > options.softLimitBytes) {
    const deleted = deleteOrdinaryBatch.run().changes;
    ordinarySnapshotsDeleted += deleted;
    if (deleted === 0) {
      break;
    }
  }

  const highSnapshotsDeleted = database
    .prepare("DELETE FROM token_snapshots WHERE sampling_level = 'high' AND captured_at < ?")
    .run(snapshotCutoff).changes;

  database.pragma("wal_checkpoint(TRUNCATE)");
  database.pragma("incremental_vacuum");

  return {
    ordinarySnapshotsDeleted,
    highSnapshotsDeleted,
    securityChecksDeleted,
    signalsDeleted,
    configVersionsDeleted,
    sizeBeforeBytes,
    sizeAfterBytes: totalDatabaseSize(options.databasePath),
  };
}
