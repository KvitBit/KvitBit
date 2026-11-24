import type * as State from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { KvitbitStackConfig } from "./config";
import { declareKvitbitEdge, declareTokenRouteLogExclusion } from "./resources/edge";
import {
  declareFoundation,
  secretAccessorGrants,
  secretDeclarations,
} from "./resources/foundation";
import { declareNetworkAndRunners } from "./resources/network";
import { declareServerService } from "./resources/server";

export const KVITBIT_STACK_NAME = "Kvitbit";

export class BootstrapPopulatedStateError extends Data.TaggedError("BootstrapPopulatedStateError")<{
  readonly stackName: string;
  readonly stage: string;
  readonly unexpectedResources: ReadonlyArray<string>;
}> {
  override get message() {
    return (
      `Refusing to run bootstrapFoundation on stack '${this.stackName}' (stage '${this.stage}'): ` +
      `state already contains non-foundation workload resource(s): ${this.unexpectedResources.join(", ")}. ` +
      `Running bootstrap against a populated state would plan deletions of live workloads. ` +
      `Run a normal full deploy instead.`
    );
  }
}

/**
 * Exact set of Alchemy logical resource IDs declared during `bootstrapFoundation` mode.
 * Any persisted resource FQN outside this set indicates a populated production stack
 * where running foundation-only bootstrap would plan destructive workload deletions.
 */
export const foundationResourceIds = (config: KvitbitStackConfig): ReadonlySet<string> => {
  const ids = new Set<string>([
    "KvitbitImages",
    "KvitbitBlobs",
    "KvitbitMobileAssets",
    "KvitbitServerSa",
    "KvitbitRunnerSa",
    "ServerBlobsAdmin",
    "RunnerBlobsAdmin",
    "ServerMobileAssetsViewer",
    "RunnerArtifactReader",
    "EdgeTokenRouteExclusion",
  ]);

  for (const decl of secretDeclarations(config)) {
    ids.add(decl.id);
  }
  for (const grant of secretAccessorGrants(config)) {
    ids.add(grant.id);
  }

  return ids;
};

/**
 * Rejects `bootstrapFoundation` before Alchemy can plan or apply if the target
 * stack/stage state already contains any non-foundation workload resources
 * (VPC, runners, Cloud Run server, edge load balancer, etc.).
 */
export const assertBootstrapSafeState = (params: {
  readonly stackName: string;
  readonly stage: string;
  readonly allowedFoundationIds: ReadonlySet<string>;
  readonly state: State.StateService;
}): Effect.Effect<
  { readonly existingFoundationResources: ReadonlyArray<string> },
  BootstrapPopulatedStateError | State.StateStoreError
> =>
  Effect.gen(function* () {
    const existingFqns = yield* params.state.list({
      stack: params.stackName,
      stage: params.stage,
    });
    const unexpectedResources = existingFqns
      .filter((fqn) => !params.allowedFoundationIds.has(fqn))
      .sort();

    if (unexpectedResources.length > 0) {
      return yield* new BootstrapPopulatedStateError({
        stackName: params.stackName,
        stage: params.stage,
        unexpectedResources,
      });
    }

    return { existingFoundationResources: existingFqns };
  });

/**
 * Shared Kvitbit stack declaration used by both `alchemy.run.ts` and hermetic tests.
 * When `config.bootstrapFoundation` is true, verifies the state store contains zero
 * non-foundation resources before returning foundation-only declarations.
 */
export const declareKvitbitStack = <R = never>(
  config: KvitbitStackConfig,
  options?: {
    readonly stackName?: string | undefined;
    readonly inspectState?: Effect.Effect<State.StateService, State.StateStoreError, R> | undefined;
  },
) =>
  Effect.gen(function* () {
    const stackName = options?.stackName ?? KVITBIT_STACK_NAME;

    if (config.bootstrapFoundation) {
      if (options?.inspectState === undefined) {
        return yield* new BootstrapPopulatedStateError({
          stackName,
          stage: config.stage,
          unexpectedResources: ["<state-inspection-unavailable>"],
        });
      }
      const stateService = yield* options.inspectState;
      yield* assertBootstrapSafeState({
        stackName,
        stage: config.stage,
        allowedFoundationIds: foundationResourceIds(config),
        state: stateService,
      });
    }

    const foundation = yield* declareFoundation(config);
    const tokenRouteExclusion = yield* declareTokenRouteLogExclusion(config);

    if (config.bootstrapFoundation) {
      return {
        stage: config.stage,
        bootstrapFoundation: true as const,
        projectId: config.projectId,
        region: config.region,
        repository: foundation.repositoryName,
        blobsBucket: foundation.blobsBucketName,
        mobileAssetsBucket: foundation.mobileAssetsBucketName,
        tokenRouteExclusion,
      };
    }

    const network = yield* declareNetworkAndRunners(config, {
      runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
      blobsBucketName: config.blobsBucket,
      runnerDependencies: foundation.runnerDependencies,
    });

    const server = yield* declareServerService(config, {
      networkName: network.networkName,
      subnetworkName: network.subnetworkName,
      blobsBucketName: config.blobsBucket,
      mobileAssetsBucketName: config.mobileAssetsBucket,
      serverServiceAccountEmail: foundation.serverServiceAccountEmail,
      serverDependencies: [...foundation.serverDependencies, ...network.networkReadyDependencies],
    });

    const edge =
      config.edge === undefined
        ? undefined
        : yield* declareKvitbitEdge(config, config.edge, server.serviceId);

    return {
      stage: config.stage,
      bootstrapFoundation: false as const,
      projectId: config.projectId,
      region: config.region,
      repository: foundation.repositoryName,
      blobsBucket: foundation.blobsBucketName,
      mobileAssetsBucket: foundation.mobileAssetsBucketName,
      network: network.networkName,
      subnetwork: network.subnetworkName,
      runners: network.runnerNames,
      runnerConfigSha: network.runnerConfigSha,
      serverService: server.serviceName,
      serverUri: server.serviceUri,
      tokenRouteExclusion,
      edge,
    };
  });
