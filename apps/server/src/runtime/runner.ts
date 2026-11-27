/**
 * Effect Cluster runner and client layers (core-ports S5/S6, board #871/#908/#913):
 * - `SingleRunnerRuntimeLive`: self-hosted single process (`KVITBIT_RUNNER_MODE=single`),
 *   DML-only SQL message + runner storage via `selfHostedRunnerLayer` from `@kvitbit/adapters/jobs`.
 * - `ClusterClientRuntimeLive`: API server in cluster mode (`KVITBIT_RUNNER_MODE=cluster`),
 *   HTTP client-only with DML-only `SqlMessageStorage` + in-memory `RunnerStorage`.
 * - `ClusterWorkerRuntimeLive`: standalone worker (`worker.ts`) with HTTP transport, DML-only SQL
 *   message + runner storage, `RunnerAddress = HOST:PORT`, and listen address `0.0.0.0:PORT`.
 */
import { BunClusterHttp } from "@effect/platform-bun";
import * as NodeClusterHttp from "@effect/platform-node/NodeClusterHttp";
import { type RunnerServices, selfHostedRunnerLayer } from "@kvitbit/adapters/jobs";
import * as Config from "effect/Config";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as RunnerAddress from "effect/cluster/RunnerAddress";
import * as RunnerStorage from "effect/cluster/RunnerStorage";
import * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as SqlRunnerStorage from "effect/cluster/SqlRunnerStorage";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type * as HttpServerError from "effect/http/HttpServerError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

// Effect's Node HTTP layer uses Undici's Agent dispatcher, which Bun does not implement.
const ClusterHttp = process.versions.bun === undefined ? NodeClusterHttp : BunClusterHttp;

/** Default cluster worker RPC port (board #899/#908). */
const DEFAULT_WORKER_PORT = 34431;

interface ClusterWorkerOptions {
  /** Advertised runner host (internal IP on GCE, e.g. `HOST`). */
  readonly host: string;
  /** Advertised and listen port (default 34431, e.g. `PORT`). */
  readonly port: number;
  /** Bind interface (default `0.0.0.0`). */
  readonly listenHost?: string | undefined;
}

/**
 * Self-hosted single-node runner (`KVITBIT_RUNNER_MODE=single`).
 * Uses DML-only SQL cluster storage (migrations run explicitly in `migrate.ts`, rule S5).
 */
export const SingleRunnerRuntimeLive: Layer.Layer<
  RunnerServices,
  Config.ConfigError,
  SqlClient.SqlClient
> = selfHostedRunnerLayer({ migrations: "deploy" });

/**
 * API server cluster client (`KVITBIT_RUNNER_MODE=cluster`, core-ports S6).
 * Dispatches workflows to remote runners via `SqlMessageStorage` (pooled endpoint safe: no
 * `SqlRunnerStorage` session advisory locks).
 */
export const ClusterClientRuntimeLive: Layer.Layer<
  RunnerServices,
  Config.ConfigError,
  SqlClient.SqlClient
> = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(
    ClusterHttp.layer({
      transport: "http",
      clientOnly: true,
      storage: "byo",
    }),
  ),
  Layer.provideMerge(SqlMessageStorage.layerStorage({})),
  Layer.provide([RunnerStorage.layerMemory, ShardingConfig.layerFromEnv(), Digest.layerWebCrypto]),
);

/**
 * Standalone cluster worker (`worker.ts`, board #908/#913):
 * plain Effect Cluster runner over HTTP with DML-only SQL message + runner storage,
 * advertising `HOST:PORT` and listening on `0.0.0.0:PORT`.
 */
const makeClusterWorkerRuntimeLayer = (
  options: ClusterWorkerOptions,
): Layer.Layer<
  RunnerServices,
  HttpServerError.ServeError | Config.ConfigError,
  SqlClient.SqlClient
> => {
  const listenHost = options.listenHost ?? "0.0.0.0";
  const shardingOverrides = {
    runnerAddress: Option.some(RunnerAddress.make(options.host, options.port)),
    runnerListenAddress: Option.some(RunnerAddress.make(listenHost, options.port)),
  };
  const storage = Layer.merge(
    SqlMessageStorage.layerStorage({}),
    SqlRunnerStorage.layerStorage({}),
  );

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(
      ClusterHttp.layer({
        transport: "http",
        storage: "byo",
        shardingConfig: shardingOverrides,
      }),
    ),
    Layer.provideMerge(storage),
    Layer.provide([ShardingConfig.layerFromEnv(shardingOverrides), Digest.layerWebCrypto]),
  );
};

const WorkerAddressConfig = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("PORT").pipe(Config.withDefault(DEFAULT_WORKER_PORT)),
  listenHost: Config.String("LISTEN_HOST").pipe(Config.withDefault("0.0.0.0")),
});

/** Live cluster worker runtime reading `HOST`, `PORT` (default 34431), and `LISTEN_HOST` (`0.0.0.0`). */
export const ClusterWorkerRuntimeLive: Layer.Layer<
  RunnerServices,
  HttpServerError.ServeError | Config.ConfigError,
  SqlClient.SqlClient
> = Layer.unwrap(Effect.map(WorkerAddressConfig, makeClusterWorkerRuntimeLayer));
