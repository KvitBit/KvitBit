/**
 * Background-execution wiring for Kvitbit (core-ports.md sections 7.3 and 10).
 *
 * This module holds no workflow definitions and no domain logic. It provides:
 * - `cronSpecs`: the typed table of Kvitbit's ClusterCrons (name, expression, time zone,
 *   skipIfOlderThan);
 * - `cronLayer` / `cronsLayer`: ClusterCron layers built from injected handler Effects
 *   (core owns the handlers: sweep queries, workflow starts, rule D16 resolution);
 * - `selfHostedRunnerLayer`: SingleRunner with SQL runner and message storage plus
 *   ClusterWorkflowEngine, for the one-process self-hosted deployment;
 * - `testRunnerLayer`: the same engine over the in-memory TestRunner, for tests.
 */

import type { ConfigError } from "effect/Config";
import * as Cron from "effect/Cron";
import * as ClusterCron from "effect/cluster/ClusterCron";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import type * as Runners from "effect/cluster/Runners";
import type * as Sharding from "effect/cluster/Sharding";
import type * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SingleRunner from "effect/cluster/SingleRunner";
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

/** Registers every cron in the table (core-ports.md 10, `CronsLive`). */
export const cronsLayer = <E, R>(
  handlers: CronHandlers<E, R>,
  options?: CronLayerOptions,
): Layer.Layer<never, never, CronRequirements<R>> =>
  cronJobs.reduce<Layer.Layer<never, never, CronRequirements<R>>>(
    (layer, job) => Layer.merge(layer, cronLayer(job, handlers[job], options)),
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
}

/**
 * Self-hosted runner (core-ports.md 10, `SelfHosted`): one process, SingleRunner with SQL
 * runner and message storage, ClusterWorkflowEngine on top. Provide a `SqlClient` (PgClient).
 * Digest comes from Web Crypto.
 */
export const selfHostedRunnerLayer = (
  options?: SelfHostedRunnerOptions,
): Layer.Layer<RunnerServices, ConfigError, SqlClient.SqlClient> =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(
      SingleRunner.layer({ runnerStorage: "sql", shardingConfig: options?.shardingConfig }),
    ),
    Layer.provide(Digest.layerWebCrypto),
  );

/**
 * In-memory runner for tests: ClusterWorkflowEngine over `TestRunner.layer` (memory message and
 * runner storage, no-op runners). Crons fire under `TestClock`.
 */
export const testRunnerLayer: Layer.Layer<RunnerServices | MessageStorage.MemoryDriver> =
  ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(TestRunner.layer));
