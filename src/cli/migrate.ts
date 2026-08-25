import dotenv from "dotenv";

import { loadAppConfig } from "../config/index.js";
import { openDatabase } from "../db/index.js";

dotenv.config({ quiet: true });

try {
  const config = loadAppConfig(
    process.env.APP_CONFIG_PATH ?? "config/default.yaml",
    process.env,
  );
  const database = openDatabase({ path: config.storage.sqlite_path });
  const version = database.pragma("user_version", { simple: true }) as number;
  database.close();
  process.stdout.write(`SQLite migrations complete; schema version ${version}\n`);
} catch {
  process.stderr.write("migration_failed: inspect configuration and database permissions\n");
  process.exitCode = 1;
}
