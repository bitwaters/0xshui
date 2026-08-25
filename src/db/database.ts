import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { MIGRATIONS } from "./migrations.js";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

function configureConnection(database: SqliteDatabase, busyTimeoutMs: number): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
  }
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
}

export function migrateDatabase(database: SqliteDatabase): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(
      `SQLite schema version ${currentVersion} is newer than supported version ${latestVersion}`,
    );
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);

  for (const migration of pending) {
    database.transaction(() => {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    })();
  }
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const absolutePath = options.path === ":memory:" ? options.path : resolve(options.path);
  if (absolutePath !== ":memory:") {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  const database = new Database(absolutePath);
  try {
    const currentVersion = database.pragma("user_version", { simple: true }) as number;
    if (currentVersion === 0) {
      database.pragma("auto_vacuum = INCREMENTAL");
    }
    configureConnection(database, options.busyTimeoutMs ?? 5_000);
    migrateDatabase(database);

    const autoVacuum = database.pragma("auto_vacuum", { simple: true }) as number;
    if (autoVacuum !== 2) {
      throw new Error("SQLite auto_vacuum must be INCREMENTAL");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
