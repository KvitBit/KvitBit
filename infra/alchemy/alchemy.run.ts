import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { declareKvitbitStack, KVITBIT_STACK_NAME } from "./src/bootstrap";
import { loadStackConfig } from "./src/config";
import { EdgeBackendServiceProvider } from "./src/resources/edge-backend-service";
import { EdgeSecurityPolicyProvider } from "./src/resources/edge-security-policy";

const stackConfig = loadStackConfig.pipe(Effect.orDie);

const gcsStateLayer = Layer.unwrap(
  stackConfig.pipe(Effect.map((config) => GCP.state({ bucketName: config.stateBucket }))),
);

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
 *
 * Safety: `KVITBIT_BOOTSTRAP_FOUNDATION=true` inspects the GCS Alchemy state before planning and
 * hard-fails if any non-foundation workload exists, preventing accidental production deletions.
 */
export default Alchemy.Stack(
  KVITBIT_STACK_NAME,
  {
    providers: Layer.mergeAll(EdgeBackendServiceProvider, EdgeSecurityPolicyProvider).pipe(
      Layer.provideMerge(GCP.providers()),
    ),
    state: gcsStateLayer,
  },
  stackConfig.pipe(Effect.flatMap(declareKvitbitStack), Effect.orDie),
);
