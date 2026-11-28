import type { InputProps } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  computeResourcePath,
  computeRoot,
  EdgeComputeResourceNotConverged,
  EdgeComputeResourceUnowned,
  isAdmitted,
  isOwnedDescription,
  makeEdgeComputeApi,
  ownedDescription,
  parseOwnedDescription,
  requireAdmittedTarget,
  requirePresent,
} from "./edge-compute-api";
import { resolvedStringProp } from "./provider-inputs";

/**
 * Cloud CDN settings of a backend that caches. Only the fields the
 * Kvitbit edge sets; Google fills the rest with its defaults.
 */
interface EdgeCdnPolicy {
  readonly cacheMode: "USE_ORIGIN_HEADERS";
  readonly negativeCaching: boolean;
  readonly cacheKeyPolicy: {
    readonly includeHost: boolean;
    readonly includeProtocol: boolean;
    readonly includeQueryString: boolean;
  };
}

/** The CDN settings Compute reports for a backend that caches. */
interface EdgeLiveCdnPolicy extends Omit<EdgeCdnPolicy, "cacheMode"> {
  /** Any Compute cache mode, so drift from the declared one shows. */
  readonly cacheMode: string;
}

interface EdgeLogConfig {
  readonly enable: boolean;
  /** Fraction of requests logged; only meaningful while `enable` is true. */
  readonly sampleRate?: number;
}

export interface EdgeBackendServiceProps {
  /** Project of the backend; identity, so a change replaces it. */
  readonly project: string;
  /** Backend service name; identity, so a change replaces it. */
  readonly name: string;
  readonly description?: string;
  /** Immutable in Compute, so a change replaces the backend. */
  readonly loadBalancingScheme: "EXTERNAL_MANAGED";
  readonly protocol: "HTTPS";
  /** Self link of the one serverless network endpoint group behind it. */
  readonly backendGroup: string;
  /** Self link of the Cloud Armor policy attached to it. */
  readonly securityPolicy: string;
  readonly logConfig: EdgeLogConfig;
  /** Cloud CDN is on exactly when a policy is given. */
  readonly cdnPolicy?: EdgeCdnPolicy;
}

export interface EdgeBackendServiceAttributes {
  readonly project: string;
  readonly name: string;
  readonly id: string;
  readonly selfLink: string;
  readonly creationTimestamp: string;
  readonly loadBalancingScheme: string;
  readonly protocol: string;
  readonly backendGroups: ReadonlyArray<string>;
  readonly securityPolicy: string | undefined;
  readonly enableCDN: boolean;
  readonly cdnPolicy: EdgeLiveCdnPolicy | undefined;
  readonly logConfig: EdgeLogConfig;
  /** The description with the Alchemy ownership marker stripped. */
  readonly description: string | undefined;
}

/**
 * A global backend service of the Kvitbit edge. The native beta.87
 * `GCP.Compute.BackendService` neither sends `cdnPolicy` nor attaches a
 * Cloud Armor policy, so this resource alone owns the whole object: its
 * fields, its CDN policy and its security policy attachment.
 */
export type EdgeBackendService = Resource<
  "Kvitbit.EdgeBackendService",
  EdgeBackendServiceProps,
  EdgeBackendServiceAttributes
>;
const EdgeBackendService = Resource<EdgeBackendService>("Kvitbit.EdgeBackendService");

export const declareEdgeBackendService =
  (id: string) => (props: InputProps<EdgeBackendServiceProps>) =>
    EdgeBackendService(id, props);

const LiveBackendService = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  selfLink: Schema.optional(Schema.String),
  creationTimestamp: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  loadBalancingScheme: Schema.optional(Schema.String),
  protocol: Schema.optional(Schema.String),
  backends: Schema.Struct({ group: Schema.optional(Schema.String) }).pipe(
    Schema.Array,
    Schema.optional,
  ),
  securityPolicy: Schema.optional(Schema.String),
  enableCDN: Schema.optional(Schema.Boolean),
  cdnPolicy: Schema.optional(
    Schema.Struct({
      cacheMode: Schema.optional(Schema.String),
      negativeCaching: Schema.optional(Schema.Boolean),
      cacheKeyPolicy: Schema.optional(
        Schema.Struct({
          includeHost: Schema.optional(Schema.Boolean),
          includeProtocol: Schema.optional(Schema.Boolean),
          includeQueryString: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
  logConfig: Schema.optional(
    Schema.Struct({
      enable: Schema.optional(Schema.Boolean),
      sampleRate: Schema.optional(Schema.Finite),
    }),
  ),
});

type LiveBackendService = typeof LiveBackendService.Type;
const backendServiceUrl = (project: string, name: string) =>
  `${computeRoot}/projects/${project}/global/backendServices/${name}`;

const toAttributes = (project: string, live: LiveBackendService): EdgeBackendServiceAttributes => {
  const cdn = live.cdnPolicy;
  return {
    project,
    name: live.name ?? "",
    id: live.id ?? "",
    selfLink: live.selfLink ?? "",
    creationTimestamp: live.creationTimestamp ?? "",
    loadBalancingScheme: live.loadBalancingScheme ?? "",
    protocol: live.protocol ?? "",
    backendGroups: Arr.flatMap(live.backends ?? [], (backend) =>
      backend.group === undefined ? [] : [backend.group],
    ),
    securityPolicy: live.securityPolicy,
    enableCDN: live.enableCDN === true,
    cdnPolicy:
      live.enableCDN === true && cdn !== undefined
        ? {
            cacheMode: cdn.cacheMode ?? "",
            negativeCaching: cdn.negativeCaching === true,
            cacheKeyPolicy: {
              includeHost: cdn.cacheKeyPolicy?.includeHost === true,
              includeProtocol: cdn.cacheKeyPolicy?.includeProtocol === true,
              includeQueryString: cdn.cacheKeyPolicy?.includeQueryString === true,
            },
          }
        : undefined,
    logConfig:
      live.logConfig?.enable === true && live.logConfig.sampleRate !== undefined
        ? { enable: true, sampleRate: live.logConfig.sampleRate }
        : { enable: live.logConfig?.enable === true },
    description: parseOwnedDescription(live.description).description,
  };
};

/**
 * The writable fields as Compute takes them. Without CDN no `cdnPolicy` is
 * sent, as Terraform did: Compute keeps its defaults and `enableCDN: false`
 * alone turns caching off.
 */
const desiredBody = (props: EdgeBackendServiceProps, description: string) => {
  const body = {
    name: props.name,
    description,
    loadBalancingScheme: props.loadBalancingScheme,
    protocol: props.protocol,
    backends: [{ group: props.backendGroup }],
    logConfig:
      props.logConfig.enable && props.logConfig.sampleRate !== undefined
        ? { enable: true, sampleRate: props.logConfig.sampleRate }
        : { enable: props.logConfig.enable },
    enableCDN: props.cdnPolicy !== undefined,
  };
  return props.cdnPolicy === undefined ? body : { ...body, cdnPolicy: props.cdnPolicy };
};

/** The declared fields the live backend does not match. */
const backendServiceDrift = (
  props: EdgeBackendServiceProps,
  description: string,
  live: LiveBackendService,
): ReadonlyArray<string> => {
  const drift: Array<string> = [];
  if ((live.description ?? "") !== description) drift.push("description");
  if (live.protocol !== props.protocol) drift.push("protocol");
  const groups = Arr.map(live.backends ?? [], (backend) => computeResourcePath(backend.group));
  if (groups.length !== 1 || groups[0] !== computeResourcePath(props.backendGroup)) {
    drift.push("backends");
  }
  const logEnabled = live.logConfig?.enable === true;
  if (
    logEnabled !== props.logConfig.enable ||
    (props.logConfig.enable &&
      props.logConfig.sampleRate !== undefined &&
      live.logConfig?.sampleRate !== props.logConfig.sampleRate)
  ) {
    drift.push("logConfig");
  }
  if ((live.enableCDN === true) !== (props.cdnPolicy !== undefined)) {
    drift.push("enableCDN");
  }
  const cdn = props.cdnPolicy;
  if (cdn !== undefined) {
    const key = live.cdnPolicy?.cacheKeyPolicy;
    if (
      live.cdnPolicy?.cacheMode !== cdn.cacheMode ||
      (live.cdnPolicy?.negativeCaching === true) !== cdn.negativeCaching ||
      (key?.includeHost === true) !== cdn.cacheKeyPolicy.includeHost ||
      (key?.includeProtocol === true) !== cdn.cacheKeyPolicy.includeProtocol ||
      (key?.includeQueryString === true) !== cdn.cacheKeyPolicy.includeQueryString
    ) {
      drift.push("cdnPolicy");
    }
  }
  return drift;
};

const securityPolicyDrift = (props: EdgeBackendServiceProps, live: LiveBackendService) =>
  computeResourcePath(live.securityPolicy) !== computeResourcePath(props.securityPolicy);

/** A PATCH under a stale fingerprint is reread and retried this often. */
const stalePatchRetries = 2;

/**
 * The provider of `EdgeBackendService`. It uses the stack's GCP
 * credentials and HTTP client, the same ones the native providers use.
 */
export const EdgeBackendServiceProvider = Provider.succeed(EdgeBackendService, {
  stables: ["project", "name", "id", "selfLink", "creationTimestamp"],

  diff: Effect.fn(function* ({ news, olds, output }) {
    const previous = olds ?? output;
    if (previous === undefined) {
      return;
    }
    // Identity fields are plain strings; an unresolved one cannot differ yet.
    const changed = (key: "project" | "name" | "loadBalancingScheme") =>
      Option.exists(resolvedStringProp(key)(news), (next) => next !== previous[key]);
    if (changed("project") || changed("name")) {
      return { action: "replace" as const, deleteFirst: false };
    }
    if (changed("loadBalancingScheme")) {
      // The same name cannot exist twice, so the old one goes first.
      return { action: "replace" as const, deleteFirst: true };
    }
  }),

  read: Effect.fn(function* ({ id, olds, output, previous }) {
    const api = yield* makeEdgeComputeApi();
    const project = output?.project ?? olds.project;
    const name = output?.name ?? olds.name;
    const live = yield* api.get(
      `Backend service ${name}`,
      backendServiceUrl(project, name),
      LiveBackendService,
    );
    if (live === undefined) {
      return;
    }
    const attributes = toAttributes(project, live);
    const owned =
      (yield* isOwnedDescription({ id, description: live.description })) ||
      (previous !== undefined && previous.selfLink === live.selfLink);
    return owned ? attributes : Unowned(attributes);
  }),

  reconcile: Effect.fn(function* ({ id, news, output }) {
    const api = yield* makeEdgeComputeApi();
    const { project, name } = news;
    const resource = `Backend service ${name}`;
    const url = backendServiceUrl(project, name);
    const description = yield* ownedDescription({ id, description: news.description });
    const body = desiredBody(news, description);
    // Every readback must still be the object admitted below.
    let admittedId: string | undefined;
    const read = (operation: string) =>
      api.get(resource, url, LiveBackendService).pipe(
        Effect.flatMap((candidate) => requirePresent({ resource, operation, live: candidate })),
        Effect.filterOrFail(
          (candidate) => admittedId === undefined || candidate.id === admittedId,
          () => EdgeComputeResourceUnowned.make({ resource }),
        ),
      );

    let live = yield* api.get(resource, url, LiveBackendService);
    if (live === undefined) {
      const inserted = yield* api.insert(
        resource,
        `${computeRoot}/projects/${project}/global/backendServices`,
        body,
      );
      // Admitted by the insert's own target ID, or else by the marker: a
      // conflict is ours only after a retried insert that went through.
      const insertedId =
        inserted === "conflict"
          ? undefined
          : (yield* api.settle(resource, project, inserted)).targetId;
      live = yield* read("insert");
      // A conflict is success only if the existing backend is ours, as
      // after a retried insert whose first attempt went through.
      if (!(yield* isAdmitted({ id, admittedId: insertedId, live }))) {
        return yield* EdgeComputeResourceUnowned.make({ resource });
      }
    } else if (!(yield* isAdmitted({ id, admittedId: output?.id, live }))) {
      // Never take over a foreign backend: adoption admits only the object
      // it read, by ID.
      return yield* EdgeComputeResourceUnowned.make({ resource });
    }

    admittedId = live.id;

    if (live.loadBalancingScheme !== news.loadBalancingScheme) {
      return yield* EdgeComputeResourceNotConverged.make({
        resource,
        fields: ["loadBalancingScheme"],
      });
    }

    // Only mutable fields, under the fingerprint just read; a concurrent
    // change (or a retried PATCH that already applied) is reread.
    const { name: _name, loadBalancingScheme: _scheme, ...mutable } = body;
    for (let attempt = 0; backendServiceDrift(news, description, live).length > 0; attempt++) {
      const patched = yield* api
        .mutate(
          resource,
          "patch",
          HttpClientRequest.patch(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ...mutable,
              fingerprint: live.fingerprint,
            }),
          ),
        )
        .pipe(
          Effect.map((operation) => ({ operation })),
          Effect.catchIf(
            (error) => error.status === 412 && attempt < stalePatchRetries,
            () => Effect.succeed({ operation: undefined }),
          ),
        );
      if (patched.operation !== undefined) {
        yield* requireAdmittedTarget({
          resource,
          admittedId,
          settled: yield* api.settle(resource, project, patched.operation),
        });
      }
      live = yield* read("patch");
      if (patched.operation !== undefined) {
        break;
      }
    }

    if (securityPolicyDrift(news, live)) {
      const attached = yield* api.mutate(
        resource,
        "setSecurityPolicy",
        HttpClientRequest.post(`${url}/setSecurityPolicy`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            securityPolicy: news.securityPolicy,
          }),
        ),
      );
      yield* requireAdmittedTarget({
        resource,
        admittedId,
        settled: yield* api.settle(resource, project, attached),
      });
      live = yield* read("setSecurityPolicy");
    }

    const remaining = [
      ...backendServiceDrift(news, description, live),
      ...(securityPolicyDrift(news, live) ? ["securityPolicy"] : []),
    ];
    if (remaining.length > 0) {
      return yield* EdgeComputeResourceNotConverged.make({
        resource,
        fields: remaining,
      });
    }
    return toAttributes(project, live);
  }),

  delete: Effect.fn(function* ({ id, output }) {
    const api = yield* makeEdgeComputeApi();
    const resource = `Backend service ${output.name}`;
    const url = backendServiceUrl(output.project, output.name);
    // A same-name object someone else recreated is not ours to delete.
    const live = yield* api.get(resource, url, LiveBackendService);
    if (live === undefined || !(yield* isAdmitted({ id, admittedId: output.id, live }))) {
      return;
    }
    const deleted = yield* api.delete(resource, url);
    if (deleted !== "gone") {
      yield* api.settle(resource, output.project, deleted, {
        ignore: ["RESOURCE_NOT_FOUND"],
      });
    }
  }),
});
