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
  CLOUD_MONITORING_API_ID,
  declareFoundation,
  secretAccessorGrants,
  secretDeclarations,
} from "./resources/foundation";
import { declareMailForwarder } from "./resources/mail";
import { declareMonitoring } from "./resources/monitoring";
import { declareNetworkAndRunners } from "./resources/network";
import { declareServerService } from "./resources/server";
import { declareTurboCache } from "./resources/turbo-cache";

export const KVITBIT_STACK_NAME = "Kvitbit";

export const feedbackSecretFqn = (stage: KvitbitStackConfig["stage"]): string =>
  `Secret-kvitbit-${stage}-feedback-github-token`;

export const altchaSecretFqn = (stage: KvitbitStackConfig["stage"]): string =>
  `Secret-kvitbit-${stage}-altcha-hmac-key`;

export const resendSecretFqn = (stage: KvitbitStackConfig["stage"]): string =>
  `Secret-kvitbit-${stage}-resend-api-key`;

export const turboCacheSecretFqn = (stage: KvitbitStackConfig["stage"]): string =>
  `Secret-kvitbit-${stage}-turbo-cache-token`;

export class BootstrapSelectionError extends Data.TaggedError("BootstrapSelectionError")<{
  readonly flagName: string;
  readonly expectedInclude: string;
  readonly observedIncludes: ReadonlyArray<string>;
}> {
  override get message() {
    return (
      `Refusing ${this.flagName}=true without exact resource selection: ` +
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
 * Enforces that a targeted secret-bootstrap CLI invocation explicitly selects ONLY the single
 * target secret container.
 */
export const assertTargetedSecretSelection = (
  config: KvitbitStackConfig,
  argv: ReadonlyArray<string>,
): Effect.Effect<void, BootstrapSelectionError> => {
  const target =
    (config.bootstrapFeedbackSecret ?? false)
      ? {
          flagName: "KVITBIT_BOOTSTRAP_FEEDBACK_SECRET",
          expectedInclude: feedbackSecretFqn(config.stage),
        }
      : (config.bootstrapAltchaSecret ?? false)
        ? {
            flagName: "KVITBIT_BOOTSTRAP_ALTCHA_SECRET",
            expectedInclude: altchaSecretFqn(config.stage),
          }
        : (config.bootstrapResendSecret ?? false)
          ? {
              flagName: "KVITBIT_BOOTSTRAP_RESEND_SECRET",
              expectedInclude: resendSecretFqn(config.stage),
            }
          : (config.bootstrapTurboCacheSecret ?? false)
            ? {
                flagName: "KVITBIT_BOOTSTRAP_TURBO_CACHE_SECRET",
                expectedInclude: turboCacheSecretFqn(config.stage),
              }
            : undefined;
  if (target === undefined) {
    return Effect.void;
  }
  const observedIncludes = parseIncludeArgs(argv);
  if (observedIncludes.length !== 1 || observedIncludes[0] !== target.expectedInclude) {
    return Effect.fail(
      new BootstrapSelectionError({
        flagName: target.flagName,
        expectedInclude: target.expectedInclude,
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
    CLOUD_MONITORING_API_ID,
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
          flagName: "KVITBIT_BOOTSTRAP_FEEDBACK_SECRET",
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

    if (config.bootstrapAltchaSecret ?? false) {
      const targetId = altchaSecretFqn(config.stage);
      const altchaDecl = secretDeclarations(config).find((decl) => decl.id === targetId);
      if (altchaDecl === undefined) {
        return yield* new BootstrapSelectionError({
          flagName: "KVITBIT_BOOTSTRAP_ALTCHA_SECRET",
          expectedInclude: targetId,
          observedIncludes: [],
        });
      }
      const secret = yield* SecretManager.Secret(altchaDecl.id, altchaDecl.props);
      return {
        stage: config.stage,
        bootstrapFoundation: false as const,
        bootstrapAltchaSecret: true as const,
        projectId: config.projectId,
        region: config.region,
        altchaSecretId: secret.secretId,
      };
    }

    if (config.bootstrapResendSecret ?? false) {
      const targetId = resendSecretFqn(config.stage);
      const resendDecl = secretDeclarations(config).find((decl) => decl.id === targetId);
      if (resendDecl === undefined) {
        return yield* new BootstrapSelectionError({
          flagName: "KVITBIT_BOOTSTRAP_RESEND_SECRET",
          expectedInclude: targetId,
          observedIncludes: [],
        });
      }
      const secret = yield* SecretManager.Secret(resendDecl.id, resendDecl.props);
      return {
        stage: config.stage,
        bootstrapFoundation: false as const,
        bootstrapResendSecret: true as const,
        projectId: config.projectId,
        region: config.region,
        resendSecretId: secret.secretId,
      };
    }

    if (config.bootstrapTurboCacheSecret ?? false) {
      const targetId = turboCacheSecretFqn(config.stage);
      const turboDecl = secretDeclarations(config).find((decl) => decl.id === targetId);
      if (turboDecl === undefined) {
        return yield* new BootstrapSelectionError({
          flagName: "KVITBIT_BOOTSTRAP_TURBO_CACHE_SECRET",
          expectedInclude: targetId,
          observedIncludes: [],
        });
      }
      const secret = yield* SecretManager.Secret(turboDecl.id, turboDecl.props);
      return {
        stage: config.stage,
        bootstrapFoundation: false as const,
        bootstrapTurboCacheSecret: true as const,
        projectId: config.projectId,
        region: config.region,
        turboCacheSecretId: secret.secretId,
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
    const mail =
      config.mail === undefined
        ? undefined
        : yield* declareMailForwarder(config, config.mail, {
            networkSelfLink: network.networkSelfLink,
            resendSecretName: foundation.resendSecretName,
          });
    const turboCache =
      config.turboCache === undefined
        ? undefined
        : yield* declareTurboCache(config, config.turboCache, {
            tokenSecretName: foundation.turboCacheTokenSecretName,
          });
    const dnsNameServers =
      foundation.dnsApi === undefined
        ? undefined
        : yield* declareKvitbitDns(
            config,
            foundation.dnsApi,
            edge?.edgeIpAddress,
            mail?.mailIpAddress,
          );
    yield* declareMonitoring(
      config,
      foundation.monitoringApi,
      server.serviceId,
      edge?.httpsForwardingRule,
    );

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
      ...(mail === undefined ? {} : { mail }),
      ...(turboCache === undefined ? {} : { turboCache }),
      ...(dnsNameServers === undefined ? {} : { dnsNameServers }),
    };
  });
