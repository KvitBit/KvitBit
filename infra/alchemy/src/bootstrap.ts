import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type { KvitbitStackConfig } from "./config";
import { declareKvitbitDns } from "./resources/dns";
import { declareKvitbitEdge, declareTokenRouteLogExclusion } from "./resources/edge";
import {
  CLOUD_DNS_API_ID,
  declareFoundation,
  secretAccessorGrants,
  secretDeclarations,
} from "./resources/foundation";
import { declareNetworkAndRunners } from "./resources/network";
import { declareServerService } from "./resources/server";

export const KVITBIT_STACK_NAME = "Kvitbit";

class StackStageMismatchError extends Schema.TaggedError<
  StackStageMismatchError,
  { readonly brand: unique symbol }
>()("StackStageMismatchError", {
  alchemyStage: Schema.String,
  configStage: Schema.Literals(["prod", "staging"]),
}) {
  override get message() {
    return `Alchemy stage '${this.alchemyStage}' must match KVITBIT_STAGE '${this.configStage}'.`;
  }
}

export class BootstrapPopulatedStateError extends Schema.TaggedError<
  BootstrapPopulatedStateError,
  { readonly brand: unique symbol }
>()("BootstrapPopulatedStateError", {
  stackName: Schema.String,
  stage: Schema.String,
  unexpectedResources: Schema.Array(Schema.String),
}) {
  override get message() {
    return (
      `Refusing to run bootstrapFoundation on stack '${this.stackName}' (stage '${this.stage}'): ` +
      `state already contains non-foundation workload resource(s): ${Arr.join(this.unexpectedResources, ", ")}. ` +
      "Running bootstrap against a populated state would plan deletions of live workloads. " +
      "Run a normal full deploy instead."
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

  if (config.dnsZones.length > 0) {
    ids.add(CLOUD_DNS_API_ID);
  }
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
const assertBootstrapSafeState = (params: {
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
    const unexpectedResources = Arr.sort(
      Arr.filter(existingFqns, (fqn) => !params.allowedFoundationIds.has(fqn)),
      Order.String,
    );

    if (unexpectedResources.length > 0) {
      return yield* BootstrapPopulatedStateError.make({
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
export const declareKvitbitStack = Effect.fn("declareKvitbitStack")(function* (
  config: KvitbitStackConfig,
) {
  const stage = yield* Stage;
  if (stage !== config.stage) {
    return yield* StackStageMismatchError.make({
      alchemyStage: stage,
      configStage: config.stage,
    });
  }

  if (config.bootstrapFoundation) {
    // Stack.build supplies State at runtime even though StackServices omits it.
    // Reuse that service so inspection shares the deploy's lease.
    const state = yield* Effect.serviceOption(State.State);
    if (Option.isNone(state)) {
      return yield* BootstrapPopulatedStateError.make({
        stackName: KVITBIT_STACK_NAME,
        stage,
        unexpectedResources: ["<state-inspection-unavailable>"],
      });
    }
    const store = yield* state.value;
    yield* assertBootstrapSafeState({
      stackName: KVITBIT_STACK_NAME,
      stage,
      allowedFoundationIds: foundationResourceIds(config),
      state: store,
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
  const dnsNameServers =
    foundation.dnsApi === undefined
      ? undefined
      : yield* declareKvitbitDns(config, foundation.dnsApi, edge?.edgeIpAddress);

  const outputs = {
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
  return dnsNameServers === undefined ? outputs : { ...outputs, dnsNameServers };
});
