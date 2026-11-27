import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

export const feedbackSecretFqn = (stage: KvitbitStackConfig["stage"]): string =>
  `Secret-kvitbit-${stage}-feedback-github-token`;

export class BootstrapSelectionError extends Data.TaggedError("BootstrapSelectionError")<{
  readonly expectedInclude: string;
  readonly observedIncludes: ReadonlyArray<string>;
}> {
  override get message() {
    return (
      `Refusing KVITBIT_BOOTSTRAP_FEEDBACK_SECRET=true without exact resource selection: ` +
      `expected --include ${this.expectedInclude} only (got [${this.observedIncludes.join(", ")}]).`
    );
  }
}

/** Extracts every `--include <value>` / `--include=<value>` selector from CLI arguments. */
export const parseIncludeArgs = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const includes: Array<string> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--include") {
      const next = argv[i + 1];
      if (next !== undefined && next.length > 0) {
        includes.push(next);
        i += 1;
      }
    } else if (arg?.startsWith("--include=")) {
      const value = arg.slice("--include=".length);
      if (value.length > 0) {
        includes.push(value);
      }
    }
  }
  return includes;
};

/**
 * Enforces that a `bootstrapFeedbackSecret` CLI invocation explicitly selects ONLY the single
 * feedback secret container (`--include Secret-kvitbit-<stage>-feedback-github-token`).
 */
export const assertFeedbackSecretSelection = (
  config: KvitbitStackConfig,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, BootstrapSelectionError> => {
  if (!(config.bootstrapFeedbackSecret ?? false)) {
    return Effect.void;
  }
  const expectedInclude = feedbackSecretFqn(config.stage);
  const observedIncludes = parseIncludeArgs(argv);
  if (observedIncludes.length !== 1 || observedIncludes[0] !== expectedInclude) {
    return Effect.fail(
      new BootstrapSelectionError({
        expectedInclude,
        observedIncludes,
      }),
    );
  }
  return Effect.void;
};

export class StackStageMismatchError extends Data.TaggedError("StackStageMismatchError")<{
  readonly alchemyStage: string;
  readonly configStage: KvitbitStackConfig["stage"];
}> {
  override get message() {
    return `Alchemy stage '${this.alchemyStage}' must match KVITBIT_STAGE '${this.configStage}'.`;
  }
}

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
export const declareKvitbitStack = (config: KvitbitStackConfig) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    if (stage !== config.stage) {
      return yield* new StackStageMismatchError({
        alchemyStage: stage,
        configStage: config.stage,
      });
    }

    if (config.bootstrapFeedbackSecret ?? false) {
      const targetId = feedbackSecretFqn(config.stage);
      const feedbackDecl = secretDeclarations(config).find((decl) => decl.id === targetId);
      if (feedbackDecl === undefined) {
        return yield* new BootstrapSelectionError({
          expectedInclude: targetId,
          observedIncludes: [],
        });
      }
      const secret = yield* SecretManager.Secret(feedbackDecl.id, feedbackDecl.props);
      return {
        stage: config.stage,
        bootstrapFoundation: false as const,
        bootstrapFeedbackSecret: true as const,
        projectId: config.projectId,
        region: config.region,
        feedbackSecretId: secret.secretId,
      };
    }

    if (config.bootstrapFoundation) {
      // Stack.build supplies State at runtime even though StackServices omits it.
      // Reuse that service so inspection shares the deploy's lease.
      const state = yield* Effect.serviceOption(State.State);
      if (Option.isNone(state)) {
        return yield* new BootstrapPopulatedStateError({
          stackName: KVITBIT_STACK_NAME,
          stage,
          unexpectedResources: ["<state-inspection-unavailable>"],
        });
      }
      yield* assertBootstrapSafeState({
        stackName: KVITBIT_STACK_NAME,
        stage,
        allowedFoundationIds: foundationResourceIds(config),
        state: yield* state.value,
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
      ...(dnsNameServers === undefined ? {} : { dnsNameServers }),
    };
  });
