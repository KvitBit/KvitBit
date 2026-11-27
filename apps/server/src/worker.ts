/**
 * Standalone Effect Cluster worker entrypoint (`bun apps/server/src/worker.ts`).
 *
 * Per board agreements #908 and #913:
 * - Plain Effect Cluster runner over HTTP with DML-only SQL storage.
 * - Advertises `RunnerAddress = HOST:PORT` (default `PORT = 34431`), listens on `0.0.0.0:PORT`.
 * - Composes `PersistenceLive`, `CoreExternalPortsLive`, `CoreLive`, all 4 workflows, and all
 *   5 ClusterCrons. No `KvitbitRunner` entity or `entities.ts`.
 */
import { CoreLive, IdGeneratorLive } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import { loadBootRuntimeConfig, makeRuntimeEnvLayer } from "./config-contract";
import { runServerMain } from "./logging/logger";
import { PersistenceLive, PgWorkerDatabaseLive } from "./persistence";
import { ServerDocumentProjectionsLive } from "./projections/documents";
import { ClusterWorkerRuntimeLive, CronsLive, WorkflowHandlersLive } from "./runtime";
import { AnalyticsLive } from "./runtime/analytics";
import { CoreExternalPortsLive } from "./wiring";

const ServerCoreLive = ServerDocumentProjectionsLive.pipe(Layer.provideMerge(CoreLive));

/**
 * Complete worker composition:
 * 1. `PgWorkerDatabaseLive` provides `SqlClient` (honoring `DATABASE_URL_UNPOOLED` for advisory
 *    locks per rule S5, falling back to `DATABASE_URL`).
 * 2. `ClusterWorkerRuntimeLive` starts the HTTP runner (`Sharding`, `WorkflowEngine`).
 * 3. `PersistenceLive` + `CoreExternalPortsLive` + `IdGeneratorLive` provide all persistence and external ports.
 * 4. `CoreLive` + `ServerDocumentProjectionsLive` provide all 9 domain modules + job services + server read projections.
 * 5. `WorkflowHandlersLive` and `CronsLive` register the 4 workflows and 5 ClusterCrons.
 */
export const WorkerLive = Layer.mergeAll(WorkflowHandlersLive, CronsLive).pipe(
  Layer.provideMerge(ServerCoreLive),
  Layer.provideMerge(IdGeneratorLive),
  Layer.provideMerge(CoreExternalPortsLive),
  Layer.provideMerge(PersistenceLive),
  Layer.provideMerge(ClusterWorkerRuntimeLive),
  Layer.provide(PgWorkerDatabaseLive),
  Layer.provide(AnalyticsLive),
);

export const workerProgram = Effect.gen(function* () {
  const boot = yield* loadBootRuntimeConfig("worker");
  yield* Effect.logInfo("Starting Kvitbit cluster worker", {
    env: boot.env,
    appOrigin: boot.appOrigin,
    emailMode: boot.email.mode,
    blobDriver: boot.blob.driver,
  });
  return yield* Layer.launch(WorkerLive);
});

const isMain =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : process.argv[1]?.endsWith("worker.ts") || process.argv[1]?.endsWith("worker.js");

if (isMain) {
  runServerMain(workerProgram.pipe(Effect.provide(makeRuntimeEnvLayer(process.env))));
}
