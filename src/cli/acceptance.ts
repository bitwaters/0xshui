import dotenv from "dotenv";

import { loadAppConfig } from "../config/index.js";
import { openDatabase, PersistenceRepository } from "../db/index.js";
import { AcceptanceService, acceptanceConfigKey } from "../operations/index.js";

dotenv.config({ quiet: true });

let database: ReturnType<typeof openDatabase> | undefined;
try {
  const config = loadAppConfig(
    process.env.APP_CONFIG_PATH ?? "config/default.yaml",
    process.env,
  );
  database = openDatabase({ path: config.storage.sqlite_path });
  const repository = new PersistenceRepository(database);
  repository.registerConfigVersion(config);
  const service = new AcceptanceService(repository, acceptanceConfigKey(config));
  const approve = process.argv.includes("--approve");
  const reject = process.argv.includes("--reject");
  if (approve && reject) throw new Error("Choose either --approve or --reject");
  const report = approve
    ? service.approve(Date.now())
    : reject
      ? service.reject(Date.now())
      : service.report(Date.now());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.eligibleForManualApproval) process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `acceptance_failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  database?.close();
}
