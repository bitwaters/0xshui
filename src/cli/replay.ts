import dotenv from "dotenv";

import { loadAppConfig } from "../config/index.js";
import { openDatabase, PersistenceRepository } from "../db/index.js";
import { ReplayRunner } from "../replay/index.js";

dotenv.config({ quiet: true });

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function timestamp(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid replay timestamp");
  return parsed;
}

let database: ReturnType<typeof openDatabase> | undefined;
try {
  const liveConfig = loadAppConfig(
    process.env.APP_CONFIG_PATH ?? "config/default.yaml",
    process.env,
  );
  const to = timestamp(valueAfter("--to"), Date.now() + 1);
  const from = timestamp(
    valueAfter("--from"),
    Math.max(0, to - liveConfig.storage.snapshot_retention),
  );
  const versionValue = valueAfter("--config-version");
  const configVersion = versionValue === undefined ? undefined : Number(versionValue);
  database = openDatabase({ path: liveConfig.storage.sqlite_path });
  const report = new ReplayRunner({
    repository: new PersistenceRepository(database),
    ...(configVersion === undefined ? {} : { configVersion }),
    from,
    to,
  }).run();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `replay_failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  database?.close();
}
