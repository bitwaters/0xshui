import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";

import { parseAppConfig, type AppConfig } from "./schema.js";

export class ConfigLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

function formatZodError(error: ZodError): string {
  const issueSummary = error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
  return `Configuration validation failed: ${issueSummary}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function applyDeploymentOverrides(
  rawConfig: unknown,
  environment: NodeJS.ProcessEnv,
): unknown {
  const telegramEnabled = environment.TELEGRAM_ENABLED?.trim().toLowerCase();
  if (telegramEnabled === undefined) return rawConfig;
  if (telegramEnabled !== "true" && telegramEnabled !== "false") {
    throw new ConfigLoadError("TELEGRAM_ENABLED must be true or false when provided");
  }
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    Array.isArray(rawConfig) ||
    typeof (rawConfig as Record<string, unknown>).telegram !== "object" ||
    (rawConfig as Record<string, unknown>).telegram === null ||
    Array.isArray((rawConfig as Record<string, unknown>).telegram)
  ) {
    return rawConfig;
  }
  const config = rawConfig as Record<string, unknown>;
  const telegram = config.telegram as Record<string, unknown>;
  return {
    ...config,
    telegram: { ...telegram, enabled: telegramEnabled === "true" },
  };
}

export function loadAppConfig(
  configPath = "config/default.yaml",
  environment: NodeJS.ProcessEnv = {},
): Readonly<AppConfig> {
  const absolutePath = resolve(configPath);
  let source: string;

  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    throw new ConfigLoadError(`Unable to read configuration file: ${absolutePath}`);
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYaml(source);
  } catch {
    throw new ConfigLoadError(`Unable to parse YAML configuration: ${absolutePath}`);
  }

  try {
    return deepFreeze(parseAppConfig(applyDeploymentOverrides(rawConfig, environment)));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigLoadError(formatZodError(error));
    }
    throw error;
  }
}
