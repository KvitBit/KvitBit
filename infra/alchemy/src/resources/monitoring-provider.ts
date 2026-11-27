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
}> {
  override get message() {
    return `Cloud Monitoring ${this.operation} ${this.resource}: ${this.reason}`;
  }
}

const root = "https://monitoring.googleapis.com/v3";
const managedLabel = { managed_by: "kvitbit-alchemy" };
const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const makeMonitoringApi = Effect.fnUntraced(function* () {
  const api = yield* makeGoogleApi();

  const send = (
    request: HttpClientRequest.HttpClientRequest,
    resource: string,
  ): Effect.Effect<JsonObject | undefined, MonitoringRequestFailed> => {
    const failed = (reason: string) =>
      new MonitoringRequestFailed({ operation: request.method, resource, reason });

    return api.call({
      request: request.pipe(HttpClientRequest.acceptJson),
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
            const { message } = object(object(body).error);
            return Effect.fail(
              failed(
                typeof message === "string"
                  ? `HTTP ${response.status}: ${message}`
                  : `HTTP ${response.status}`,
              ),
            );
          }),
        );
      },
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
  readonly immutableChanged?: (current: P, next: P) => boolean;
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
  const owns = (body: JsonObject) => object(body.userLabels).managed_by === managedLabel.managed_by;

  const find = Effect.fnUntraced(function* (props: P) {
    const api = yield* makeMonitoringApi();
    let pageToken: string | undefined;
    let found: MonitoringAttributes | undefined;
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
          body.displayName !== props.displayName ||
          (definition.immutableMatches && !definition.immutableMatches(props, body))
        ) {
          continue;
        }
        if (found) {
          return yield* new MonitoringRequestFailed({
            operation: "list",
            resource: props.displayName,
            reason: "multiple resources match the desired identity",
          });
        }
        found = yield* attributes(props.project, body);
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);
    return found;
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

  return {
    stables: ["project", "name", "resourceId"] satisfies Array<keyof MonitoringAttributes>,
    read: Effect.fnUntraced(function* ({
      olds,
      output,
    }: {
      olds: P;
      output: MonitoringAttributes | undefined;
    }) {
      if (output !== undefined) return yield* readByName(output);
      const found = yield* find(olds);
      return found !== undefined && !owns(found.body) ? Unowned(found) : found;
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
        if (!isResolved(news)) return undefined;
        if (
          news.project !== olds.project ||
          definition.immutableChanged?.(olds, news) ||
          (output !== undefined && definition.immutableMatches?.(news, output.body) === false)
        ) {
          return { action: "replace" as const, deleteFirst: false };
        }
        return output && drifted(news, output.body).length
          ? { action: "update" as const }
          : undefined;
      }),
    reconcile: ({ news, output }: { news: P; output: MonitoringAttributes | undefined }) =>
      mutations.withPermit(
        Effect.gen(function* () {
          const api = yield* makeMonitoringApi();
          const known = output === undefined ? undefined : yield* readByName(output);
          const existing = known ?? (yield* find(news));

          if (existing === undefined) {
            const created = yield* api.send(
              HttpClientRequest.post(collectionUrl(news.project)).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  ...mutable(news),
                  ...definition.createFields?.(news),
                  userLabels: managedLabel,
                }),
              ),
              news.displayName,
            );
            return yield* attributes(news.project, created ?? {});
          }

          if (
            (known === undefined && !owns(existing.body)) ||
            definition.immutableMatches?.(news, existing.body) === false
          ) {
            return yield* new MonitoringRequestFailed({
              operation: "reconcile",
              resource: existing.name,
              reason: "resource does not match the admitted identity",
            });
          }

          const changed = drifted(news, existing.body);
          if (changed.length === 0) return existing;
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
          return yield* attributes(news.project, patched ?? {});
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

// Protobuf omits empty repeated fields and can return extra default fields.
const matches = (desired: unknown, live: unknown): boolean => {
  if (Array.isArray(desired)) {
    return Array.isArray(live)
      ? desired.length === live.length && desired.every((item, index) => matches(item, live[index]))
      : desired.length === 0 && live === undefined;
  }
  if (desired !== null && typeof desired === "object") {
    const current = object(live);
    return Object.entries(desired).every(([key, value]) => matches(value, current[key]));
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
      current.host !== next.host || current.period !== next.period,
    immutableMatches: ({ host, period }, live) => {
      const target = object(live.monitoredResource);
      return (
        target.type === "uptime_url" &&
        object(target.labels).host === host &&
        live.period === period
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
          content: "ok",
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
