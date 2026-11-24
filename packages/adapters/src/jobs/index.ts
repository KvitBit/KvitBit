/**
 * Background-execution wiring for Kvitbit (core-ports.md sections 7.3 and 10).
 *
 * This module holds no workflow definitions and no domain logic. It provides:
 * - `cronSpecs`: the typed table of Kvitbit's ClusterCrons (name, expression, time zone,
 *   skipIfOlderThan);
 * - `cronLayer` / `cronsLayer`: ClusterCron layers built from injected handler Effects
 *   (core owns the handlers: sweep queries, workflow starts, rule D16 resolution);
 * - `selfHostedRunnerLayer`: single-runner Sharding over DML-only SQL runner and message storage
 *   plus ClusterWorkflowEngine, for the one-process self-hosted deployment, and
 *   `clusterStorageMigrationsLayer` for the deploy step (rule S5);
 * - `testRunnerLayer`: the same engine over the in-memory TestRunner, for tests.
 */

import type { ConfigError } from "effect/Config";
import * as Cron from "effect/Cron";
import * as ClusterCron from "effect/cluster/ClusterCron";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import * as RunnerHealth from "effect/cluster/RunnerHealth";
import * as Runners from "effect/cluster/Runners";
import * as Sharding from "effect/cluster/Sharding";
import * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as SqlRunnerStorage from "effect/cluster/SqlRunnerStorage";
import * as TestRunner from "effect/cluster/TestRunner";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";

/** Time zone for every business-calendar cron (Czech invoicing day). */
export const PRAGUE = "Europe/Prague";

/** One row of the cron table. */
export interface CronSpec {
  /** Stable ClusterCron name; also the entity type suffix in cluster storage. Never rename. */
  readonly name: `kvitbit/${string}`;
  /** Five-field cron expression (minute hour day-of-month month day-of-week). */
  readonly expression: string;
  /** IANA time zone the expression is evaluated in. */
  readonly timeZone: string;
  /** A run whose scheduled time is older than this when it executes is skipped. */
  readonly skipIfOlderThan: Duration.Duration;
  /** What the injected handler is expected to do. Documentation only. */
  readonly purpose: string;
}

/**
 * Kvitbit's ClusterCrons. Names, expressions and skip windows follow core-ports.md 7.3;
 * `reminderSweep` is the overdue-reminder safety net requested for Phase 2 (see its purpose).
 */
export const cronSpecs = {
  recurringSweep: {
    name: "kvitbit/recurring-sweep",
    expression: "*/15 * * * *",
    timeZone: PRAGUE,
    skipIfOlderThan: Duration.hours(1),
    purpose:
      "Start RecurringIssuance for each active schedule with next_occurrence <= today (Prague), " +
      "or pause it when more than 7 days late; one occurrence per schedule per tick.",
  },
  reminderSweep: {
    name: "kvitbit/reminder-sweep",
    expression: "0 8 * * *",
    timeZone: PRAGUE,
    skipIfOlderThan: Duration.hours(6),
    purpose:
      "Find issued, unsettled, non-cancelled Invoices/Proformas past due whose reminders are on " +
      "under the effective policy (rule D16: Document -> Contact -> Workspace, resolved by core) " +
      "and (re)start PaymentReminders for the current reminder epoch with its deterministic key.",
  },
  cnbFixing: {
    name: "kvitbit/cnb-fixing",
    expression: "45 14-17 * * 1-5",
    timeZone: PRAGUE,
    skipIfOlderThan: Duration.hours(1),
    purpose:
      "Warm today's CNB fixing into fx_fixings (ExchangeRates.fixing(today)); no-op when present. " +
      "Retries hourly until 17:45 on weekdays.",
  },
  outboxReconcile: {
    name: "kvitbit/outbox-reconcile",
    expression: "* * * * *",
    timeZone: "UTC",
    skipIfOlderThan: Duration.minutes(5),
    purpose:
      "Re-execute DocumentDelivery (queued/sending), MemberInvitation (pending) and DataExport " +
      "(running) intents older than 2 minutes with their original keys (rules J1, J1a).",
  },
  housekeeping: {
    name: "kvitbit/housekeeping",
    expression: "30 3 * * *",
    timeZone: PRAGUE,
    skipIfOlderThan: Duration.hours(6),
    purpose:
      "Delete request_log rows and staged blobs older than 24 h, roll up share views, and remove " +
      "export rows and ZIPs past expires_at.",
  },
} as const satisfies Record<string, CronSpec>;

export type CronJob = keyof typeof cronSpecs;

/** All cron keys in table order. */
export const cronJobs = Object.keys(cronSpecs) as ReadonlyArray<CronJob>;

/** Parses a spec's expression in its time zone. Throws `CronParseError` on an invalid row. */
export const parseCron = (spec: CronSpec): Cron.Cron =>
  Cron.parseUnsafe(spec.expression, spec.timeZone);

/** The scheduled time of the run being executed; available inside every handler. */
export const CurrentScheduledTime = ClusterCron.CurrentScheduledTime;

/** A handler: core's sweep body. It may read `CurrentScheduledTime`. */
export type CronHandler<E = never, R = never> = Effect.Effect<void, E, R>;

/** One handler per cron in the table. */
export type CronHandlers<E = never, R = never> = { readonly [K in CronJob]: CronHandler<E, R> };

/** What a set of cron layers needs from the composition root. */
export type CronRequirements<R> =
  | Sharding.Sharding
  | Exclude<Exclude<R, ClusterCron.CurrentScheduledTime>, Scope>;

export interface CronLayerOptions {
  /** Cluster shard group for the cron entity and its singleton. Default "default". */
  readonly shardGroup?: string | undefined;
}

/**
 * Registers one cron from the table with an injected handler. A failing or dying handler is
 * logged as a warning and swallowed: the run completes, the next tick is scheduled as usual, and
 * the failure is not turned into an entity defect (which would restart the cron entity and
 * redeliver the same run). Sweeps are idempotent and the next tick retries.
 */
export const cronLayer = <E, R>(
  job: CronJob,
  handler: CronHandler<E, R>,
  options?: CronLayerOptions,
): Layer.Layer<never, never, CronRequirements<R>> => {
  const spec: CronSpec = cronSpecs[job];
  return ClusterCron.make({
    name: spec.name,
    cron: parseCron(spec),
    execute: Effect.catchCause(handler, (cause) =>
      Effect.logWarning("Kvitbit cron handler failed", cause).pipe(
        Effect.annotateLogs({ cron: spec.name }),
      ),
    ),
    skipIfOlderThan: spec.skipIfOlderThan,
    shardGroup: options?.shardGroup,
  });
};

/** Any complete handlers record; each handler may have its own error and service types. */
export type AnyCronHandlers = { readonly [K in CronJob]: CronHandler<unknown, unknown> };

/**
 * Registers every cron in the table (core-ports.md 10, `CronsLive`). Error and service types are
 * the unions over the record's handlers.
 */
export const cronsLayer = <H extends AnyCronHandlers>(
  handlers: H,
  options?: CronLayerOptions,
): Layer.Layer<never, never, CronRequirements<Effect.Services<H[CronJob]>>> =>
  cronJobs.reduce<Layer.Layer<never, never, CronRequirements<Effect.Services<H[CronJob]>>>>(
    (layer, job) =>
      Layer.merge(
        layer,
        cronLayer(
          job,
          handlers[job] as CronHandler<Effect.Error<H[CronJob]>, Effect.Services<H[CronJob]>>,
          options,
        ),
      ),
    Layer.empty,
  );

/** Services the runner layers provide to workflows, crons and modules. */
export type RunnerServices =
  | WorkflowEngine.WorkflowEngine
  | Sharding.Sharding
  | Runners.Runners
  | MessageStorage.MessageStorage;

export interface SelfHostedRunnerOptions {
  /** Overrides on top of the `ShardingConfig` read from the environment. */
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined;
  /**
   * Where the `cluster_*` table migrations run. "deploy" (default, rule S5): the runtime role is
   * DML-only and the deploy step runs `clusterStorageMigrationsLayer` with the owner role.
   * "startup": the runner applies them itself, which needs DDL rights (single-role installs).
   */
  readonly migrations?: "deploy" | "startup" | undefined;
}

/**
 * Cluster storage migrations (message and runner tables) for the deploy step, run with the owner
 * role (rule S5). Provide a `SqlClient` on the direct endpoint.
 */
export const clusterStorageMigrationsLayer: Layer.Layer<never, never, SqlClient.SqlClient> =
  Layer.merge(SqlMessageStorage.layerMigrations({}), SqlRunnerStorage.layerMigrations({}));

/**
 * Self-hosted runner (core-ports.md 10, `SelfHosted`; rule S6): one process acting as the single
 * runner, with SQL message and runner storage and ClusterWorkflowEngine on top. This is
 * `SingleRunner.layer({ runnerStorage: "sql" })` rebuilt over the DML-only storage layers, because
 * 4.1.4's `SingleRunner.layer` always runs the cluster migrations at startup. Provide a
 * `SqlClient` (PgClient, direct endpoint: runner storage holds session advisory locks).
 * Digest comes from Web Crypto.
 */
export const selfHostedRunnerLayer = (
  options?: SelfHostedRunnerOptions,
): Layer.Layer<RunnerServices, ConfigError, SqlClient.SqlClient> => {
  const storage = Layer.merge(
    SqlMessageStorage.layerStorage({}),
    SqlRunnerStorage.layerStorage({}),
  ).pipe(
    Layer.provide(options?.migrations === "startup" ? clusterStorageMigrationsLayer : Layer.empty),
  );
  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(Sharding.layer),
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(storage),
    Layer.provide([RunnerHealth.layerNoop, Digest.layerWebCrypto]),
    Layer.provide(ShardingConfig.layerFromEnv(options?.shardingConfig)),
  );
};

/**
 * In-memory runner for tests: ClusterWorkflowEngine over `TestRunner.layer` (memory message and
 * runner storage, no-op runners). Crons fire under `TestClock`.
 */
export const testRunnerLayer: Layer.Layer<RunnerServices | MessageStorage.MemoryDriver> =
  ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(TestRunner.layer));
