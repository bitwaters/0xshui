import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { bootstrapApplication } from "../src/bootstrap.js";

test("application bootstrap migrates storage, versions config, and recovers on reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "gmgn-bootstrap-test-"));
  try {
    const configPath = join(directory, "config.yaml");
    const databasePath = join(directory, "signals.sqlite");
    const raw = parseYaml(readFileSync("config/default.yaml", "utf8")) as Record<string, unknown>;
    raw.storage = {
      ...(raw.storage as Record<string, unknown>),
      sqlite_path: databasePath,
    };
    writeFileSync(configPath, stringifyYaml(raw), "utf8");

    const environment = {
      APP_CONFIG_PATH: configPath,
      GMGN_API_KEY: "bootstrap-test-key",
    };
    const first = bootstrapApplication(environment);
    assert.equal(first.configVersion, 1);
    assert.equal(first.recoveredState.nextIngestSeq, 1);
    first.database.close();

    const second = bootstrapApplication(environment);
    try {
      assert.equal(second.configVersion, 1);
      assert.equal(second.recoveredState.nextIngestSeq, 1);
      assert.equal(
        (
          second.database
            .prepare("SELECT COUNT(*) AS count FROM config_versions")
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      second.database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
