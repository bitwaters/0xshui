import {
  loadAppConfig,
  loadRuntimeCredentials,
  type AppConfig,
  type RuntimeCredentials,
} from "./config/index.js";
import {
  openDatabase,
  PersistenceRepository,
  type RecoveredState,
  type SqliteDatabase,
} from "./db/index.js";
import { createLogger, type AppLogger } from "./logging/index.js";

export interface ApplicationContext {
  readonly config: Readonly<AppConfig>;
  readonly credentials: RuntimeCredentials;
  readonly logger: AppLogger;
  readonly database: SqliteDatabase;
  readonly repository: PersistenceRepository;
  readonly configVersion: number;
  readonly recoveredState: RecoveredState;
}

export function bootstrapApplication(
  environment: NodeJS.ProcessEnv = process.env,
): ApplicationContext {
  const config = loadAppConfig(
    environment.APP_CONFIG_PATH ?? "config/default.yaml",
    environment,
  );
  const credentials = loadRuntimeCredentials(config, environment);
  const secrets = [
    credentials.gmgnApiKey,
    ...(credentials.telegram === null
      ? []
      : [credentials.telegram.botToken, credentials.telegram.chatId]),
  ];
  const logger = createLogger({
    level: config.logging.level,
    secrets,
  });
  logger.info("config_loaded", {
    chain: config.chain,
    mode: config.mode,
    telegram_enabled: config.telegram.enabled,
  });

  let database: SqliteDatabase | undefined;
  try {
    database = openDatabase({ path: config.storage.sqlite_path });
    const repository = new PersistenceRepository(database);
    const configVersion = repository.registerConfigVersion(config);
    const recoveredState = repository.recoverStartupState(
      Date.now(),
      config.noise.creator_cooldown,
    );
    return Object.freeze({
      config,
      credentials,
      logger,
      database,
      repository,
      configVersion,
      recoveredState,
    });
  } catch (error) {
    logger.error("storage_failed", error, { phase: "startup" });
    database?.close();
    throw error;
  }
}
