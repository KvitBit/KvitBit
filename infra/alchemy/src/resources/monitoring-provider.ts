import { createInternalLabels, sanitizeLabelValue } from "@alchemy.run/gcp";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";
import * as Semaphore from "effect/Semaphore";
import { makeGoogleApi } from "../google-api";

type JsonObject = Readonly<Record<string, unknown>>;
type UptimePeriod = "60s" | "300s" | "600s" | "900s";

interface MonitoringProps {
  readonly project: string;
  readonly displayName: string;
  /** Upstream dependencies that must settle before the first Monitoring API call. */
  readonly apiReady?: string;
}

export interface UptimeCheckProps extends MonitoringProps {
  readonly host: string;
  readonly port: number;
  readonly period: UptimePeriod;
}

export interface MetricAggregation {
  readonly alignmentPeriod: "300s" | "1200s";
  readonly perSeriesAligner: "ALIGN_DELTA" | "ALIGN_NEXT_OLDER";
  readonly crossSeriesReducer: "REDUCE_SUM" | "REDUCE_COUNT_FALSE";
}

export interface MetricThreshold {
  readonly filter: string;
  readonly aggregations: ReadonlyArray<MetricAggregation>;
  readonly denominatorFilter?: string;
  readonly denominatorAggregations?: ReadonlyArray<MetricAggregation>;
  readonly comparison: "COMPARISON_GT";
  readonly thresholdValue: number;
  readonly duration: "0s" | "120s";
  readonly trigger: { readonly count: 1 };
}

export interface AlertPolicyProps extends MonitoringProps {
  readonly condition: {
    readonly displayName: string;
    readonly conditionThreshold: MetricThreshold;
  };
  readonly notificationChannels: ReadonlyArray<string>;
}

export interface NotificationChannelProps extends MonitoringProps {
  readonly email: string;
}

interface MonitoringAttributes {
  readonly project: string;
  readonly name: string;
  readonly resourceId: string;
  readonly body: JsonObject;
}

type MonitoringResource<Type extends string, Props extends MonitoringProps> = Resource<
  Type,
  Props,
  MonitoringAttributes
>;

export const UptimeCheck = Resource<
  MonitoringResource<"Kvitbit.Monitoring.UptimeCheck", UptimeCheckProps>
>("Kvitbit.Monitoring.UptimeCheck");
export const AlertPolicy = Resource<
  MonitoringResource<"Kvitbit.Monitoring.AlertPolicy", AlertPolicyProps>
>("Kvitbit.Monitoring.AlertPolicy");
export const NotificationChannel = Resource<
  MonitoringResource<"Kvitbit.Monitoring.NotificationChannel", NotificationChannelProps>
>("Kvitbit.Monitoring.NotificationChannel");

class MonitoringRequestFailed extends Data.TaggedError("MonitoringRequestFailed")<{
  readonly operation: string;
  readonly resource: string;
  readonly reason: string;
  readonly serviceDisabled?: boolean;
}> {
  override get message() {
    return `Cloud Monitoring ${this.operation} ${this.resource}: ${this.reason}`;
  }
}

const root = "https://monitoring.googleapis.com/v3";
const generationLabel = "alchemy-instance";
const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const makeMonitoringApi = Effect.fnUntraced(function* () {
  const api = yield* makeGoogleApi();

  const send = (
    request: HttpClientRequest.HttpClientRequest,
    resource: string,
  ): Effect.Effect<JsonObject | undefined, MonitoringRequestFailed> => {
    const failed = (reason: string, serviceDisabled = false) =>
      new MonitoringRequestFailed({ operation: request.method, resource, reason, serviceDisabled });

    return api.call({
      request: request.pipe(HttpClientRequest.acceptJson),
      tokenLookup: "once",
      // POST assigns a new ID every time. A later reconcile lists before creating.
      policy: {
        attemptTimeout: "20 seconds",
        backoff: "500 millis",
        retries: request.method === "POST" ? 0 : 3,
      },
      handle: (response) => {
        if (response.status === 404 && (request.method === "DELETE" || request.method === "GET")) {
          return Effect.succeed(undefined);
        }
        if (response.status >= 200 && response.status < 300) {
          return request.method === "DELETE"
            ? Effect.succeed({})
            : response.json.pipe(
                Effect.map(object),
                Effect.mapError(() => failed("invalid JSON response")),
              );
        }
        return response.json.pipe(
          Effect.orElseSucceed(() => ({})),
          Effect.flatMap((body) => {
            const { message, details } = object(object(body).error);
            const serviceDisabled =
              request.method === "GET" &&
              response.status === 403 &&
              Array.isArray(details) &&
              details.some((detail) => object(detail).reason === "SERVICE_DISABLED");
            return Effect.fail(
              failed(
                typeof message === "string"
                  ? `HTTP ${response.status}: ${message}`
                  : `HTTP ${response.status}`,
                serviceDisabled,
              ),
            );
          }),
        );
      },
      retryHandledFailure: (failure) => failure.serviceDisabled === true,
      transientStatus: (status) => failed(`HTTP ${status}`),
      noAnswer: (cause) => failed(cause),
      credentialsUnavailable: () => failed("credentials unavailable"),
    });
  };

  return { send };
});

interface MonitoringDefinition<P extends MonitoringProps> {
  readonly collection: "uptimeCheckConfigs" | "alertPolicies" | "notificationChannels";
  readonly mutable: (props: P, live?: JsonObject) => JsonObject;
  readonly createFields?: (props: P) => JsonObject;
  readonly immutableMatches?: (props: P, live: JsonObject) => boolean;
  readonly immutableChanged?: (current: P, next: JsonObject) => boolean;
  readonly verifyReadback?: boolean;
}

interface MonitoringIdentity {
  readonly fqn: string;
  readonly instanceId: string;
}

// Monitoring requires alert-policy writes and channel writes to be serialized per project.
// Each stack invocation operates on a single project and holds the Alchemy state lease.
const mutations = Semaphore.makeUnsafe(1);

function monitoringLifecycle<P extends MonitoringProps>(definition: MonitoringDefinition<P>) {
  const { collection } = definition;
  const collectionUrl = (project: string) => `${root}/projects/${project}/${collection}`;
  const attributes = (
    project: string,
    body: JsonObject,
  ): Effect.Effect<MonitoringAttributes, MonitoringRequestFailed> => {
    const { name } = body;
    const match = typeof name === "string" && /^projects\/[^/]+\/([^/]+)\/([^/]+)$/.exec(name);
    if (typeof name !== "string" || !match || match[1] !== collection || !match[2]) {
      return Effect.fail(
        new MonitoringRequestFailed({
          operation: "read",
          resource: collection,
          reason: "invalid resource name in response",
        }),
      );
    }
    return Effect.succeed({ project, name, resourceId: match[2], body });
  };
  const find = Effect.fnUntraced(function* (
    props: P,
    labels: Record<string, string>,
    instanceId: string,
    previous?: MonitoringAttributes,
  ) {
    const api = yield* makeMonitoringApi();
    let pageToken: string | undefined;
    const exact: MonitoringAttributes[] = [];
    const owned: MonitoringAttributes[] = [];
    const foreign: MonitoringAttributes[] = [];
    do {
      const request = HttpClientRequest.get(collectionUrl(props.project));
      const page: JsonObject | undefined = yield* api.send(
        pageToken ? HttpClientRequest.setUrlParam(request, "pageToken", pageToken) : request,
        props.displayName,
      );
      if (page === undefined) {
        return yield* new MonitoringRequestFailed({
          operation: "list",
          resource: collection,
          reason: "collection not found",
        });
      }
      const entries = page[collection];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const body = object(entry);
        if (
          (previous !== undefined && body.name === previous.name) ||
          (definition.immutableMatches && !definition.immutableMatches(props, body))
        ) {
          continue;
        }
        const liveLabels = object(body.userLabels);
        if (Object.entries(labels).every(([key, value]) => liveLabels[key] === value)) {
          if (liveLabels[generationLabel] === instanceId) {
            exact.push(yield* attributes(props.project, body));
          } else if (previous === undefined) {
            owned.push(yield* attributes(props.project, body));
          }
        } else if (body.displayName === props.displayName) {
          foreign.push(yield* attributes(props.project, body));
        }
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);
    const matching = exact.length > 0 ? exact : [...owned, ...foreign];
    if (matching.length > 1) {
      return yield* new MonitoringRequestFailed({
        operation: "list",
        resource: props.displayName,
        reason: "multiple resources match the desired identity",
      });
    }
    const resource = matching[0];
    return resource === undefined
      ? undefined
      : { resource, exact: exact.includes(resource), owned: !foreign.includes(resource) };
  });

  const readByName = Effect.fnUntraced(function* (output: MonitoringAttributes) {
    const api = yield* makeMonitoringApi();
    const body = yield* api.send(HttpClientRequest.get(`${root}/${output.name}`), output.name);
    return body === undefined ? undefined : yield* attributes(output.project, body);
  });

  const mutable = (props: P, live?: JsonObject) => ({
    displayName: props.displayName,
    ...definition.mutable(props, live),
  });
  const drifted = (props: P, live: JsonObject) =>
    Object.entries(mutable(props, live)).filter(([field, value]) => !matches(value, live[field]));

  const invalid = (body: JsonObject) =>
    definition.verifyReadback === true &&
    body.validity !== undefined &&
    object(body.validity).code !== 0;

  const verify = (
    resource: MonitoringAttributes,
    expected: JsonObject,
  ): Effect.Effect<MonitoringAttributes, MonitoringRequestFailed> => {
    const body = resource.body;
    if (
      definition.verifyReadback === true &&
      (invalid(body) ||
        !Object.entries(expected).every(([key, value]) => matches(value, body[key])))
    ) {
      return Effect.fail(
        new MonitoringRequestFailed({
          operation: "reconcile",
          resource: resource.name,
          reason:
            "alert policy is invalid or its returned configuration differs from the requested policy",
        }),
      );
    }
    return Effect.succeed(resource);
  };

  return {
    stables: ["project", "name", "resourceId"] satisfies Array<keyof MonitoringAttributes>,
    read: Effect.fnUntraced(function* ({
      olds,
      output,
      previous,
      fqn,
      instanceId,
    }: MonitoringIdentity & {
      olds: P;
      output: MonitoringAttributes | undefined;
      previous?: MonitoringAttributes;
    }) {
      if (output !== undefined) return yield* readByName(output);
      const labels = yield* createInternalLabels(fqn);
      const found = yield* find(olds, labels, sanitizeLabelValue(instanceId), previous);
      if (found === undefined) return undefined;
      return found.owned ? found.resource : Unowned(found.resource);
    }),
    diff: ({
      olds,
      news,
      output,
    }: {
      olds: P;
      news: Input<P>;
      output: MonitoringAttributes | undefined;
    }) =>
      Effect.sync(() => {
        const next = object(news);
        if (
          (typeof next.project === "string" && next.project !== olds.project) ||
          definition.immutableChanged?.(olds, next) ||
          (isResolved(news) &&
            output !== undefined &&
            definition.immutableMatches?.(news, output.body) === false)
        ) {
          return { action: "replace" as const, deleteFirst: false };
        }
        if (!isResolved(news)) return undefined;
        return output && (invalid(output.body) || drifted(news, output.body).length > 0)
          ? { action: "update" as const }
          : undefined;
      }),
    reconcile: ({
      fqn,
      instanceId,
      news,
      output,
    }: MonitoringIdentity & {
      news: P;
      output: MonitoringAttributes | undefined;
    }) =>
      mutations.withPermit(
        Effect.gen(function* () {
          const api = yield* makeMonitoringApi();
          const labels = yield* createInternalLabels(fqn);
          const generation = sanitizeLabelValue(instanceId);
          const known = output === undefined ? undefined : yield* readByName(output);
          const found = known === undefined ? yield* find(news, labels, generation) : undefined;
          const existing = known ?? found?.resource;

          if (existing === undefined) {
            const created = yield* api.send(
              HttpClientRequest.post(collectionUrl(news.project)).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  ...mutable(news),
                  ...definition.createFields?.(news),
                  userLabels: { ...labels, [generationLabel]: generation },
                }),
              ),
              news.displayName,
            );
            const resource = yield* attributes(news.project, created ?? {});
            return yield* verify(resource, mutable(news, resource.body));
          }

          if (
            (found !== undefined && !found.exact) ||
            definition.immutableMatches?.(news, existing.body) === false
          ) {
            return yield* new MonitoringRequestFailed({
              operation: "reconcile",
              resource: existing.name,
              reason: "resource does not match the admitted identity",
            });
          }

          const changed = drifted(news, existing.body);
          const expected = mutable(news, existing.body);
          if (changed.length === 0) return yield* verify(existing, expected);
          const patched = yield* api.send(
            HttpClientRequest.patch(`${root}/${existing.name}`).pipe(
              HttpClientRequest.setUrlParam(
                "updateMask",
                changed.map(([field]) => field).join(","),
              ),
              HttpClientRequest.bodyJsonUnsafe({
                name: existing.name,
                ...Object.fromEntries(changed),
              }),
            ),
            existing.name,
          );
          const resource = yield* attributes(news.project, patched ?? {});
          return yield* verify(resource, expected);
        }),
      ),
    delete: ({ output }: { output: MonitoringAttributes }) =>
      mutations.withPermit(
        Effect.gen(function* () {
          const api = yield* makeMonitoringApi();
          yield* api.send(HttpClientRequest.delete(`${root}/${output.name}`), output.name);
        }),
      ),
  };
}

// Protobuf can omit empty repeated fields and emit optional defaults.
const protobufDefault = (value: unknown) =>
  value === undefined ||
  value === "" ||
  value === false ||
  value === 0 ||
  (typeof value === "string" && value.endsWith("_UNSPECIFIED")) ||
  (Array.isArray(value) && value.length === 0) ||
  (value !== null && typeof value === "object" && Object.keys(value).length === 0);

const matches = (desired: unknown, live: unknown): boolean => {
  if (Array.isArray(desired)) {
    return Array.isArray(live)
      ? desired.length === live.length && desired.every((item, index) => matches(item, live[index]))
      : desired.length === 0 && live === undefined;
  }
  if (desired !== null && typeof desired === "object") {
    const expected = object(desired);
    const current = object(live);
    return (
      Object.entries(expected).every(([key, value]) => matches(value, current[key])) &&
      Object.entries(current).every(
        ([key, value]) => Object.hasOwn(expected, key) || protobufDefault(value),
      )
    );
  }
  return Object.is(desired, live);
};

export const UptimeCheckProvider = Provider.succeed(
  UptimeCheck,
  monitoringLifecycle<UptimeCheckProps>({
    collection: "uptimeCheckConfigs",
    createFields: ({ project, host, period }) => ({
      monitoredResource: { type: "uptime_url", labels: { project_id: project, host } },
      period,
    }),
    immutableChanged: (current, next) =>
      (typeof next.host === "string" && current.host !== next.host) ||
      (typeof next.period === "string" && current.period !== next.period),
    immutableMatches: ({ host, period }, live) => {
      const target = object(live.monitoredResource);
      return (
        target.type === "uptime_url" &&
        object(target.labels).host === host &&
        (live.period ?? "60s") === period
      );
    },
    mutable: ({ port }) => ({
      httpCheck: {
        requestMethod: "GET",
        path: "/readyz",
        port,
        useSsl: true,
        validateSsl: true,
        acceptedResponseStatusCodes: [{ statusValue: 200 }],
      },
      timeout: "10s",
      contentMatchers: [
        {
          matcher: "MATCHES_JSON_PATH",
          // Cloud Monitoring parses MATCHES_JSON_PATH + EXACT_MATCH content as a JSON value.
          content: JSON.stringify("ok"),
          jsonPathMatcher: { jsonPath: "$.status", jsonMatcher: "EXACT_MATCH" },
        },
      ],
    }),
  }),
);

export const AlertPolicyProvider = Provider.succeed(
  AlertPolicy,
  monitoringLifecycle<AlertPolicyProps>({
    collection: "alertPolicies",
    verifyReadback: true,
    mutable: ({ condition, notificationChannels }, live) => {
      // Each policy owns one condition. Its generated name preserves identity across edits.
      const conditions = live?.conditions;
      const name = Array.isArray(conditions) ? object(conditions[0]).name : undefined;
      return {
        combiner: "OR",
        enabled: true,
        conditions: [typeof name === "string" ? { ...condition, name } : condition],
        notificationChannels,
      };
    },
  }),
);

export const NotificationChannelProvider = Provider.succeed(
  NotificationChannel,
  monitoringLifecycle<NotificationChannelProps>({
    collection: "notificationChannels",
    createFields: () => ({ type: "email" }),
    immutableMatches: (_props, live) => live.type === "email",
    mutable: ({ email }) => ({ enabled: true, labels: { email_address: email } }),
  }),
);
