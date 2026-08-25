import dotenv from "dotenv";
import { Bot } from "grammy";

import { bootstrapApplication } from "./bootstrap.js";
import { ConfigLoadError, CredentialError } from "./config/index.js";
import { runDatabaseMaintenance, type SqliteDatabase } from "./db/index.js";
import {
  GmgnContractError,
  GmgnError,
  getGmgnHttpClient,
  runGmgnSelfCheck,
} from "./gmgn/index.js";
import {
  AcceptanceService,
  acceptanceConfigKey,
  GmgnRequestMetrics,
  HealthMonitor,
  MetricsService,
} from "./operations/index.js";
import { createGmgnOutcomeDataSource, OutcomeWorker } from "./outcomes/index.js";
import {
  createMarketPollers,
  RealtimeScheduler,
  SecurityManager,
  SnapshotCoordinator,
  TokenWindowStore,
  WeightedRateLimiter,
  type RealtimeSource,
} from "./realtime/index.js";
import { SignalEngine } from "./runtime/index.js";
import { registerStatsCommand, StatsService } from "./stats/index.js";
import { TelegramPublisher } from "./telegram/index.js";

dotenv.config({ quiet: true });

const OUTCOME_TICK_MS = 30_000;
const OPERATIONS_TICK_MS = 60_000;
const MAINTENANCE_TICK_MS = 24 * 60 * 60_000;

function reportStartupFailure(error: unknown): void {
  if (error instanceof ConfigLoadError || error instanceof CredentialError) {
    process.stderr.write(`startup_failed: ${error.message}\n`);
    return;
  }
  process.stderr.write("startup_failed: unexpected initialization error\n");
}

function isStorageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_")
  );
}

async function run(): Promise<void> {
  let database: SqliteDatabase | undefined;
  let scheduler: RealtimeScheduler | undefined;
  let limiter: WeightedRateLimiter | undefined;
  let bot: Bot | undefined;
  const timers: NodeJS.Timeout[] = [];
  try {
    const context = bootstrapApplication();
    database = context.database;
    const acceptanceKey = acceptanceConfigKey(context.config);
    const health = new HealthMonitor(context.config.telegram.enabled);
    const gmgnRequestMetrics = new GmgnRequestMetrics();
    const persistRequestMetrics = (now: number) => {
      const snapshot = gmgnRequestMetrics.snapshot(true);
      context.repository.addRuntimeCounter(
        `gmgn_request_attempts:${acceptanceKey}`,
        snapshot.attempts,
        now,
      );
      context.repository.addRuntimeCounter(
        `gmgn_request_successes:${acceptanceKey}`,
        snapshot.successes,
        now,
      );
      return snapshot;
    };
    health.markHealthy("storage", Date.now());
    const activeLimiter = new WeightedRateLimiter({
      ratePerSecond: context.config.gmgn.local_weight_limit_per_second,
      capacity: context.config.gmgn.local_weight_limit_per_second,
      initialCooldownUntil: context.recoveredState.cooldownUntil,
      repository: context.repository,
    });
    limiter = activeLimiter;
    const client = getGmgnHttpClient({
      apiKey: context.credentials.gmgnApiKey,
      baseUrl: context.config.gmgn.base_url,
      userAgent: context.config.gmgn.user_agent,
      timeoutMs: context.config.gmgn.request_timeout,
      maxResponseBytes: context.config.gmgn.max_response_size,
      beforeAttempt: activeLimiter.beforeAttempt,
      onAttemptCompleted: (metric) => gmgnRequestMetrics.record(metric),
      onRateLimit: async (error) => {
        const priorCooldown = activeLimiter.getCooldownUntil();
        if (priorCooldown !== null && priorCooldown > Date.now()) {
          context.repository.setRuntimeState("last_uncontrolled_429_at", Date.now());
          context.repository.incrementRuntimeCounter(`uncontrolled_429_count:${acceptanceKey}`);
        }
        await activeLimiter.onRateLimit(error);
        context.repository.incrementRuntimeCounter("rate_limit_count");
        context.repository.incrementRuntimeCounter(`rate_limit_count:${acceptanceKey}`);
        context.logger.warn("rate_limit_paused", { cooldown_until: error.cooldownUntil });
      },
    });
    const selfCheck = await runGmgnSelfCheck(client);
    if (!selfCheck.ok) {
      context.repository.incrementRuntimeCounter("schema_failure_count");
      context.repository.setRuntimeState("last_schema_failure_at", Date.now());
      context.repository.incrementRuntimeCounter(`schema_failure_count:${acceptanceKey}`);
      context.repository.setRuntimeState(`last_schema_failure_at:${acceptanceKey}`, Date.now());
      context.logger.error("schema_contract_failed", new Error("GMGN startup self-check failed"), {
        reason: selfCheck.reason,
        clock_drift_ms: selfCheck.clockDriftMs,
      });
      throw new Error("GMGN startup gate failed");
    }
    health.markHealthy("gmgn", Date.now());

    const outcomeWorker = new OutcomeWorker({
      repository: context.repository,
      dataSource: createGmgnOutcomeDataSource(client),
    });
    const stats = new StatsService({
      repository: context.repository,
      timeZone: context.config.report_timezone,
      hitGain: context.config.outcomes.hit_gain,
      largeGain: context.config.outcomes.large_gain,
      configVersion: context.configVersion,
    });
    const metrics = new MetricsService(context.repository);
    const acceptance = new AcceptanceService(
      context.repository,
      acceptanceKey,
      context.configVersion,
    );
    if (context.config.mode === "shadow") acceptance.ensureShadowStarted(Date.now());
    if (
      context.config.mode === "production" &&
      acceptance.report(Date.now()).productionActivation !== "approved"
    ) {
      throw new Error("Production activation has not received acceptance approval");
    }

    let publisher: TelegramPublisher | undefined;
    if (context.credentials.telegram !== null) {
      bot = new Bot(context.credentials.telegram.botToken);
      publisher = new TelegramPublisher({
        api: bot.api,
        repository: context.repository,
        chatId: context.credentials.telegram.chatId,
        outcomeCheckpointsMs: context.config.outcomes.checkpoints,
        onSent: async (tokenKey) => {
          await outcomeWorker.capturePoolBaseline(tokenKey);
        },
      });
      registerStatsCommand(bot, stats, context.credentials.telegram.chatId);
      void bot.start({ onStart: () => health.markHealthy("telegram", Date.now()) }).catch((error) => {
        health.markFailed("telegram", Date.now());
        context.logger.error("startup_failed", error, { component: "telegram" });
      });
    } else {
      health.markHealthy("telegram", Date.now());
    }

    const windowStore = new TokenWindowStore(
      60_000,
      10,
      context.config.gmgn.source_max_age_for_trigger,
    );
    const engineRef: { current?: SignalEngine } = {};
    const securityManager = new SecurityManager({
      client,
      repository: context.repository,
      windowStore,
      concurrency: context.config.gmgn.security_max_concurrency,
      cacheTtlMs: context.config.gmgn.security_cache,
      sendMaximumAgeMs: context.config.gmgn.security_max_age_at_send,
      onCompleted: async (tokenKey, snapshot, capturedAt) => {
        health.recordSecurityResult(snapshot !== null, capturedAt);
        try {
          await engineRef.current?.processToken(tokenKey, capturedAt);
        } catch (error) {
          if (isStorageError(error)) health.markFailed("storage", Date.now());
          context.logger.error("storage_failed", error, { phase: "security_completion" });
        }
      },
    });
    const coordinator = new SnapshotCoordinator({
      repository: context.repository,
      windowStore,
      ordinarySnapshotIntervalMs: context.config.storage.baseline_snapshot_interval,
      isHighPriority: (tokenKey) => securityManager.getCached(tokenKey) !== null,
      onCommitted: (_source, _ingestSeq, tokenKeys, capturedAt) => {
        void engineRef.current?.processTokens(tokenKeys, capturedAt).catch((error) => {
          if (isStorageError(error)) health.markFailed("storage", Date.now());
        });
      },
    });
    engineRef.current = new SignalEngine({
      config: context.config,
      configVersion: context.configVersion,
      repository: context.repository,
      windowStore,
      security: securityManager,
      ...(publisher === undefined ? {} : { publisher }),
      logger: context.logger,
      health,
      recoveredRecentSignals: context.recoveredState.recentSent.map((signal) => ({
        tokenKey: signal.tokenKey,
        sentAt: signal.sentAt,
        priority: signal.priority,
        ...(signal.creatorAddress === null ? {} : { creatorAddress: signal.creatorAddress }),
      })),
    });
    const successfulSources = new Set<RealtimeSource>();
    scheduler = new RealtimeScheduler({
      intervalMs: context.config.poll_interval,
      sources: createMarketPollers({
        client,
        coordinator,
        onSuccess: (source, capturedAt) => {
          health.markHealthy("storage", capturedAt);
          successfulSources.add(source);
          if (
            successfulSources.size === 3 &&
            windowStore.isSourceFresh("trenches", capturedAt) &&
            windowStore.isSourceFresh("rank_1m", capturedAt) &&
            windowStore.isSourceFresh("rank_5m", capturedAt)
          ) {
            health.markHealthy("gmgn", capturedAt);
          }
          context.logger.debug("poll_completed", { source, captured_at: capturedAt });
        },
        onFailure: (source, error) => {
          if (isStorageError(error)) {
            health.markFailed("storage", Date.now());
            context.logger.error("storage_failed", error, { source });
          } else {
            health.markDegraded("gmgn", Date.now());
            if (error instanceof GmgnContractError || !(error instanceof GmgnError)) {
              context.repository.incrementRuntimeCounter("schema_failure_count");
              context.repository.setRuntimeState("last_schema_failure_at", Date.now());
              context.repository.incrementRuntimeCounter(`schema_failure_count:${acceptanceKey}`);
              context.repository.setRuntimeState(
                `last_schema_failure_at:${acceptanceKey}`,
                Date.now(),
              );
              context.logger.error("schema_contract_failed", error, { source });
            }
          }
        },
        onOverlap: (source) => context.logger.warn("poll_skipped_overlap", { source }),
      }),
    });
    scheduler.start();

    timers.push(
      setInterval(() => {
        void outcomeWorker.runDue().catch((error) => {
          context.logger.error("schema_contract_failed", error, { component: "outcomes" });
        });
      }, OUTCOME_TICK_MS),
      setInterval(() => {
        const now = Date.now();
        if (context.config.mode === "shadow") acceptance.recordHeartbeat(now);
        const requestSnapshot = persistRequestMetrics(now);
        context.logger.info("stats_generated", {
          health: health.snapshot(now),
          metrics: metrics.collect(0, now + 1, context.configVersion),
          gmgn_requests: requestSnapshot,
          security_queue_length: securityManager.getQueueSize(),
          security_active: securityManager.getActiveCount(),
          research_outcome_queue_length: context.repository.countPendingResearchOutcomes(),
        });
        if (context.config.telegram.daily_report && context.credentials.telegram !== null && bot !== undefined) {
          const activeBot = bot;
          const telegram = context.credentials.telegram;
          void stats
            .sendDailyOnce((text) =>
              activeBot.api
                .sendMessage(telegram.chatId, text, { parse_mode: "HTML" })
                .then(() => undefined),
            )
            .catch((error) =>
              context.logger.error("startup_failed", error, { component: "daily_report" }),
            );
        }
      }, OPERATIONS_TICK_MS),
      setInterval(() => {
        try {
          runDatabaseMaintenance(context.database, {
            databasePath: context.config.storage.sqlite_path,
            now: Date.now(),
            snapshotRetentionMs: context.config.storage.snapshot_retention,
            signalRetentionMs: context.config.storage.signal_retention,
            softLimitBytes: context.config.storage.sqlite_soft_limit,
          });
        } catch (error) {
          health.markFailed("storage", Date.now());
          context.logger.error("storage_failed", error, { phase: "maintenance" });
        }
      }, MAINTENANCE_TICK_MS),
    );

    context.logger.info("app_started", {
      mode: context.config.mode,
      clock_drift_ms: selfCheck.clockDriftMs,
      health: health.snapshot(Date.now()),
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    for (const timer of timers) clearInterval(timer);
    bot?.stop();
    bot = undefined;
    activeLimiter.stop();
    await scheduler.stop();
    persistRequestMetrics(Date.now());
    health.stop();
    context.logger.info("app_stopped", {
      reason: "signal",
      acceptance: context.config.mode === "shadow" ? acceptance.report(Date.now()) : undefined,
    });
  } catch (error) {
    reportStartupFailure(error);
    process.exitCode = 1;
  } finally {
    for (const timer of timers) clearInterval(timer);
    bot?.stop();
    limiter?.stop();
    await scheduler?.stop().catch(() => undefined);
    database?.close();
  }
}

await run();
