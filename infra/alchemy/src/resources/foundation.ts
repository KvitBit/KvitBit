import type { RepositoryProps } from "@alchemy.run/gcp/ArtifactRegistry";
import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import type { MemberProps, ServiceAccountProps } from "@alchemy.run/gcp/IAM";
import * as IAM from "@alchemy.run/gcp/IAM";
import type { SecretProps } from "@alchemy.run/gcp/SecretManager";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import type { BucketProps } from "@alchemy.run/gcp/Storage";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Effect from "effect/Effect";
import type { KvitbitStackConfig, KvitbitWorkload } from "../config";
import { resourceNames, secretResourceName, serviceAccountEmail, stackLabels } from "../config";

export const artifactRepositoryProps = (config: KvitbitStackConfig): RepositoryProps => ({
  repositoryId: config.artifactRepositoryId,
  location: config.region,
  format: "DOCKER",
  description: "Kvitbit container images, deployed by immutable digest.",
  labels: stackLabels(config),
  dockerConfig: { immutableTags: true },
});

export const blobsBucketProps = (config: KvitbitStackConfig): BucketProps => ({
  bucketName: config.blobsBucket,
  location: config.region.toUpperCase(),
  storageClass: "STANDARD",
  versioning: true,
  uniformBucketLevelAccess: true,
  forceDestroy: false,
  labels: stackLabels(config),
});

export const mobileAssetsBucketProps = (config: KvitbitStackConfig): BucketProps => ({
  bucketName: config.mobileAssetsBucket,
  location: config.region.toUpperCase(),
  storageClass: "STANDARD",
  versioning: true,
  uniformBucketLevelAccess: true,
  forceDestroy: false,
  labels: stackLabels(config),
});

export const serverServiceAccountProps = (config: KvitbitStackConfig): ServiceAccountProps => ({
  project: config.projectId,
  accountId: resourceNames(config).serverServiceAccountId,
  displayName: `Kvitbit ${config.stage} Cloud Run server`,
  description: "Least-privilege runtime identity for the Kvitbit Cloud Run HTTP/MCP server.",
});

export const runnerServiceAccountProps = (config: KvitbitStackConfig): ServiceAccountProps => ({
  project: config.projectId,
  accountId: resourceNames(config).runnerServiceAccountId,
  displayName: `Kvitbit ${config.stage} Effect Cluster runner`,
  description: "Least-privilege runtime identity for the Kvitbit Compute Engine worker pool.",
});

export const secretDeclarations = (
  config: KvitbitStackConfig,
): ReadonlyArray<{ readonly id: string; readonly secretId: string; readonly props: SecretProps }> =>
  config.secrets.map((secret) => ({
    id: `Secret-${secret.secretId}`,
    secretId: secret.secretId,
    props: {
      secretId: secret.secretId,
      labels: stackLabels(config),
      replication: { automatic: {} },
    },
  }));

export interface SecretAccessorGrant {
  readonly id: string;
  readonly secretId: string;
  readonly workload: KvitbitWorkload;
  readonly props: MemberProps;
}

export const secretAccessorGrants = (
  config: KvitbitStackConfig,
): ReadonlyArray<SecretAccessorGrant> => {
  const names = resourceNames(config);
  const saEmail = (workload: KvitbitWorkload) =>
    serviceAccountEmail(
      config.projectId,
      workload === "server" ? names.serverServiceAccountId : names.runnerServiceAccountId,
    );

  return config.secrets.flatMap((secret) =>
    secret.consumers.map((workload) => ({
      id: `SecretAccess-${secret.secretId}-${workload}`,
      secretId: secret.secretId,
      workload,
      props: {
        kind: "secretmanager.secret" as const,
        name: secretResourceName(config.projectId, secret.secretId),
        role: "roles/secretmanager.secretAccessor",
        member: `serviceAccount:${saEmail(workload)}`,
      },
    })),
  );
};

export const declareFoundation = Effect.fn("KvitbitStack.declareFoundation")(function* (
  config: KvitbitStackConfig,
) {
  const repository = yield* ArtifactRegistry.Repository(
    "KvitbitImages",
    artifactRepositoryProps(config),
  );
  const blobsBucket = yield* Storage.Bucket("KvitbitBlobs", blobsBucketProps(config));
  const mobileAssetsBucket = yield* Storage.Bucket(
    "KvitbitMobileAssets",
    mobileAssetsBucketProps(config),
  );

  const serverSa = yield* IAM.ServiceAccount("KvitbitServerSa", serverServiceAccountProps(config));
  const runnerSa = yield* IAM.ServiceAccount("KvitbitRunnerSa", runnerServiceAccountProps(config));

  // Least-privilege GCS bucket access
  yield* IAM.Member("ServerBlobsAdmin", {
    kind: "storage.bucket",
    name: blobsBucket.bucketName,
    role: "roles/storage.objectAdmin",
    member: serverSa.email.pipe((email) => `serviceAccount:${email}`),
  });
  yield* IAM.Member("RunnerBlobsAdmin", {
    kind: "storage.bucket",
    name: blobsBucket.bucketName,
    role: "roles/storage.objectAdmin",
    member: runnerSa.email.pipe((email) => `serviceAccount:${email}`),
  });
  yield* IAM.Member("ServerMobileAssetsViewer", {
    kind: "storage.bucket",
    name: mobileAssetsBucket.bucketName,
    role: "roles/storage.objectViewer",
    member: serverSa.email.pipe((email) => `serviceAccount:${email}`),
  });

  // Runner VMs pull the Kvitbit OCI image from Artifact Registry
  yield* IAM.Member("RunnerArtifactReader", {
    kind: "artifactregistry.repository",
    name: repository.name,
    role: "roles/artifactregistry.reader",
    member: runnerSa.email.pipe((email) => `serviceAccount:${email}`),
  });

  // Secret Manager containers (operator populates secret versions out-of-band)
  const secretResources = new Map<string, SecretManager.Secret>();
  for (const decl of secretDeclarations(config)) {
    const secret = yield* SecretManager.Secret(decl.id, decl.props);
    secretResources.set(decl.secretId, secret);
  }

  // Per-workload secretAccessor bindings
  const secretGrants = new Map<string, IAM.Member>();
  for (const grant of secretAccessorGrants(config)) {
    const secretResource = secretResources.get(grant.secretId);
    const sa = grant.workload === "server" ? serverSa : runnerSa;
    const member = yield* IAM.Member(grant.id, {
      ...grant.props,
      name: secretResource !== undefined ? secretResource.name : grant.props.name,
      member: sa.email.pipe((email) => `serviceAccount:${email}`),
    });
    secretGrants.set(`${grant.secretId}|${grant.workload}`, member);
  }

  return {
    repositoryName: repository.name,
    blobsBucketName: blobsBucket.bucketName,
    mobileAssetsBucketName: mobileAssetsBucket.bucketName,
    serverServiceAccountEmail: serverSa.email,
    runnerServiceAccountEmail: runnerSa.email,
    secretGrants,
  };
});
