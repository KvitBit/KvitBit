/**
 * Production HTTP server entrypoint (`bun apps/server/src/main.ts`).
 *
 * Per board agreements #871, #878, #908, #913 and core-ports S5/S6:
 * - Binds `$HOST:$PORT` (default `0.0.0.0:8080`).
 * - Uses `DATABASE_URL` (pooled runtime-role DML connection). Never runs migrations at boot.
 * - `KVITBIT_RUNNER_MODE=single`: runs in-process `SingleRunnerRuntimeLive` + all 4 workflows +
 *   all 5 ClusterCrons alongside the HTTP server.
 * - `KVITBIT_RUNNER_MODE=cluster`: runs `ClusterClientRuntimeLive` (client-only sharding over
 *   `SqlMessageStorage`) and serves HTTP only; workflows and crons execute on `worker.ts`.
 */
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { CoreLive, IdGeneratorLive } from "@kvitbit/core";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";
import { AllRoutesLive, EdgeServicesLive } from "./app";
import { ServerConfig } from "./config";
import { loadBootRuntimeConfig, makeRuntimeEnvLayer } from "./config-contract";
import { withRequestLogging } from "./http/edge/requestId";
import { runServerMain } from "./logging/logger";
import { PersistenceLive, PgDatabaseLive } from "./persistence";
import { ServerDocumentProjectionsLive } from "./projections/documents";
import {
  ClusterClientRuntimeLive,
  CronsLive,
  SingleRunnerRuntimeLive,
  WorkflowHandlersLive,
} from "./runtime";
import { AnalyticsLive } from "./runtime/analytics";
import { CoreExternalPortsLive } from "./wiring";

const ServerCoreLive = ServerDocumentProjectionsLive.pipe(Layer.provideMerge(CoreLive));

const ServerRuntimeLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const httpLayer = HttpRouter.serve(AllRoutesLive, {
      routerConfig: { maxParamLength: 2048 },
      disableLogger: true,
      middleware: (handle) => withRequestLogging(HttpMiddleware.logger(handle)),
    }).pipe(
      Layer.provide(EdgeServicesLive),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: config.host,
          port: config.port,
        }),
      ),
    );

    if (config.runnerMode === "cluster") {
      return httpLayer.pipe(
        Layer.provide(ServerCoreLive),
        Layer.provide(IdGeneratorLive),
        Layer.provide(CoreExternalPortsLive),
        Layer.provide(PersistenceLive),
        Layer.provide(ClusterClientRuntimeLive),
        Layer.provide(PgDatabaseLive),
      );
    }

    const singleNodeWorkers = Layer.mergeAll(WorkflowHandlersLive, CronsLive);
    return Layer.merge(httpLayer, singleNodeWorkers).pipe(
      Layer.provide(ServerCoreLive),
      Layer.provide(IdGeneratorLive),
      Layer.provide(CoreExternalPortsLive),
      Layer.provide(PersistenceLive),
      Layer.provide(SingleRunnerRuntimeLive),
      Layer.provide(PgDatabaseLive),
    );
  }),
).pipe(Layer.provide(AnalyticsLive));

export const serverProgram = Effect.gen(function* () {
  const boot = yield* loadBootRuntimeConfig("server");
  const config = yield* ServerConfig;
  yield* Effect.logInfo("Starting Kvitbit server", {
    env: boot.env,
    host: config.host,
    port: config.port,
    runnerMode: config.runnerMode,
    appOrigin: config.appOrigin,
    emailMode: boot.email.mode,
    blobDriver: boot.blob.driver,
  });
  return yield* Layer.launch(ServerRuntimeLive);
});

const isMain =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");

if (isMain) {
  runServerMain(serverProgram.pipe(Effect.provide(makeRuntimeEnvLayer(process.env))));
}
