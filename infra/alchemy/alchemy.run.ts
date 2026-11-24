import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadStackConfig } from "./src/config";
import { declareKvitbitEdge } from "./src/resources/edge";
import { EdgeBackendServiceProvider } from "./src/resources/edge-backend-service";
import { EdgeSecurityPolicyProvider } from "./src/resources/edge-security-policy";
import { declareFoundation } from "./src/resources/foundation";
import { declareNetworkAndRunners } from "./src/resources/network";
import { declareServerService } from "./src/resources/server";

const stackConfig = loadStackConfig.pipe(Effect.orDie);

/**
 * Pure-Alchemy GCP stack for Kvitbit (zero Terraform).
 *
 * Provisions:
 * 1. Foundation: Artifact Registry (immutable tags), GCS blobs + mobile assets buckets,
 *    least-privilege runtime service accounts, Secret Manager secret containers & accessor grants.
 * 2. Networking & Effect Cluster Runner Pool (#908): custom VPC, private subnet, Cloud Router/NAT,
 *    internal TCP 34431 firewall, and Container-Optimized OS Compute Engine instances running
 *    `docker run --network host <kvitbit image> worker` with Chromium and Secret Manager boot fetch.
 * 3. Cloud Run Server: runs the same Kvitbit OCI image in `server` mode (`KVITBIT_RUNNER_MODE=cluster`)
 *    with Direct VPC egress to the runner pool and `/healthz` probes.
 * 4. Optional Edge (when `KVITBIT_EDGE_DOMAINS` is set, e.g. `kvitbit.cz,kvitbit.app`):
 *    External HTTPS Load Balancer, Serverless NEG, Cloud Armor WAF + auth rate limiting,
 *    Cloud CDN for immutable static assets, Managed SSL certificate, and token-route log exclusion.
 */
export default Alchemy.Stack(
  "Kvitbit",
  {
    providers: Layer.mergeAll(EdgeBackendServiceProvider, EdgeSecurityPolicyProvider).pipe(
      Layer.provideMerge(GCP.providers()),
    ),
    state: Layer.unwrap(
      stackConfig.pipe(Effect.map((config) => GCP.state({ bucketName: config.stateBucket }))),
    ),
  },
  Effect.gen(function* () {
    const config = yield* stackConfig;

    const foundation = yield* declareFoundation(config);

    const network = yield* declareNetworkAndRunners(config, {
      runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
      blobsBucketName: config.blobsBucket,
    });

    const server = yield* declareServerService(config, {
      networkName: network.networkName,
      subnetworkName: network.subnetworkName,
      blobsBucketName: config.blobsBucket,
      mobileAssetsBucketName: config.mobileAssetsBucket,
      serverServiceAccountEmail: foundation.serverServiceAccountEmail,
    });

    const edge =
      config.edge === undefined
        ? undefined
        : yield* declareKvitbitEdge(config, config.edge, server.serviceId);

    return {
      stage: config.stage,
      projectId: config.projectId,
      region: config.region,
      repository: foundation.repositoryName,
      blobsBucket: foundation.blobsBucketName,
      mobileAssetsBucket: foundation.mobileAssetsBucketName,
      network: network.networkName,
      subnetwork: network.subnetworkName,
      runners: network.runnerNames,
      serverService: server.serviceName,
      serverUri: server.serviceUri,
      edge,
    };
  }),
);
