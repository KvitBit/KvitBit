import { expect, test } from "bun:test";
import { fromAccessToken } from "@alchemy.run/gcp";
import * as Apply from "alchemy/Apply";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  AlertPolicy,
  AlertPolicyProvider,
  NotificationChannel,
  NotificationChannelProvider,
  UptimeCheck,
  type UptimeCheckProps,
  UptimeCheckProvider,
} from "../src/resources/monitoring-provider";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const pathPattern = /^\/v3\//;

type Body = Record<string, Schema.Json>;
const parseBody = Fn.flow(
  Schema.decodeResult(Schema.fromJsonString(Schema.JsonObject)),
  Result.getOrThrow,
);
const parseJson = Schema.decodeResult(Schema.fromJsonString(Schema.Json));
const project = "example-project";
const checkName = "example-staging HTTPS readiness";
const emailName = "example-staging operations email";

function monitoringApi(options: { loseFirstCreate?: boolean; disabledOnFirstRead?: boolean } = {}) {
  const resources = new Map<string, Body>();
  const requests: Array<{ method: string; path: string; mask: string | null; body: Body }> = [];
  let nextId = 0;
  let disabled = options.disabledOnFirstRead;
  const faults = { invalidPolicyPatch: false, loseNextCreate: options.loseFirstCreate === true };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (
        url.origin !== "https://monitoring.googleapis.com" ||
        request.headers["authorization"] !== "Bearer test-token"
      ) {
        throw new Error("Monitoring sent a request to the wrong origin or without authentication");
      }
      const path = Str.replace(pathPattern, "")(url.pathname);
      const [projectSegment, projectId, collection, id] = Str.split(path, "/");
      if (projectSegment !== "projects" || projectId !== project) {
        throw new Error(`Unexpected Monitoring project path: ${path}`);
      }
      const body: Body =
        request.body._tag === "Uint8Array" ? parseBody(request.body.text ?? "") : {};
      const mask = url.searchParams.get("updateMask");
      requests.push({ method: request.method, path, mask, body });
      const reply = (response: Schema.Json = {}, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(response, { status }));
      const current = resources.get(path);

      if (request.method === "GET" && collection !== undefined && collection !== "") {
        if (disabled === true) {
          disabled = false;
          return reply({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, 403);
        }
        if (id !== undefined && id !== "")
          return current !== undefined ? reply(current) : reply({}, 404);
        const candidates = Arr.map(
          Arr.filter([...resources.entries()], ([name]) => Str.startsWith(`${path}/`)(name)),
          ([, value]) => value,
        );
        // One item per page to exercise interrupted-create recovery across pages.
        const index = Number(url.searchParams.get("pageToken") ?? 0);
        const nextPageTokenFields =
          index + 1 < candidates.length ? { nextPageToken: String(index + 1) } : {};
        return reply({
          [collection]: candidates.slice(index, index + 1),
          ...nextPageTokenFields,
        });
      }
      const validateUptimeContentMatchers = (candidate: Body) => {
        if (collection !== "uptimeCheckConfigs" || !Arr.isArray(candidate["contentMatchers"])) {
          return null;
        }
        for (const matcher of candidate["contentMatchers"]) {
          if (
            Schema.is(Schema.JsonObject)(matcher) &&
            "matcher" in matcher &&
            matcher["matcher"] === "MATCHES_JSON_PATH" &&
            "jsonPathMatcher" in matcher &&
            Schema.is(Schema.JsonObject)(matcher["jsonPathMatcher"]) &&
            "jsonMatcher" in matcher["jsonPathMatcher"] &&
            matcher["jsonPathMatcher"]["jsonMatcher"] === "EXACT_MATCH"
          ) {
            if (Result.isFailure(parseJson(String(matcher["content"] ?? "")))) {
              return reply(
                {
                  error: {
                    code: 400,
                    message:
                      "Unable to parse 'required_content' as JSON value. Make sure to quote strings and property names.",
                  },
                },
                400,
              );
            }
          }
        }
        return null;
      };

      if (request.method === "POST") {
        if (body["name"] !== undefined) throw new Error("Unexpected name on Monitoring create");
        const invalid = validateUptimeContentMatchers(body);
        if (invalid !== null) return invalid;
        const name = `${path}/${++nextId}`;
        const created: Body = { ...body, name };
        if (Arr.isArray(created["conditions"])) {
          created["conditions"] = Arr.map(created["conditions"], (condition) => {
            const fields = Schema.is(Schema.JsonObject)(condition) ? condition : {};
            return { ...fields, name: `${name}/conditions/1` };
          });
        }
        resources.set(name, created);
        if (faults.loseNextCreate) {
          faults.loseNextCreate = false;
          return reply({}, 503);
        }
        return reply(created);
      }
      if (request.method === "PATCH" && current !== undefined) {
        if (body["name"] !== path) throw new Error("Monitoring patch names the wrong resource");
        const invalid = validateUptimeContentMatchers(body);
        if (invalid !== null) return invalid;
        const expectedMask = Arr.filter(EffectRecord.keys(body), (key) => key !== "name").sort(
          Order.String,
        );
        const actualMask = mask === null ? [] : Arr.sort(Str.split(mask, ","), Order.String);
        if (Arr.join(actualMask, ",") !== Arr.join(expectedMask, ",")) {
          throw new Error("Monitoring patch update mask differs from its body");
        }
        if (
          collection === "uptimeCheckConfigs" &&
          !Arr.every(EffectRecord.keys(body), (key) =>
            ["name", "displayName", "httpCheck", "timeout", "contentMatchers"].includes(key),
          )
        )
          throw new Error("Monitoring patch includes an immutable uptime field");
        const patched = { ...current, ...body };
        if (collection === "alertPolicies" && faults.invalidPolicyPatch) {
          faults.invalidPolicyPatch = false;
          return reply({ ...patched, validity: { code: 3 } });
        }
        resources.set(path, patched);
        return reply(patched);
      }
      if (request.method === "DELETE") {
        if (url.searchParams.has("force"))
          throw new Error("Monitoring delete must preserve its dependency checks");
        for (const policy of resources.values()) {
          if (
            collection === "uptimeCheckConfigs" &&
            id !== undefined &&
            id !== "" &&
            Arr.isArray(policy["conditions"]) &&
            Str.includes(`check_id=\\"${id}\\"`)(encodeJson(policy["conditions"]))
          )
            return reply({}, 400);
          const channels = Schema.decodeUnknownOption(Schema.Array(Schema.String))(
            policy["notificationChannels"],
          ).pipe(Option.getOrElse(() => []));
          if (
            collection === "notificationChannels" &&
            Arr.some(channels, (channel) => channel === path)
          )
            return reply({}, 400);
        }
        return resources.delete(path) ? reply() : reply({}, 404);
      }
      return reply({}, 404);
    }),
  );
  return { client, requests, resources, faults };
}

const providers = Layer.mergeAll(
  UptimeCheckProvider,
  AlertPolicyProvider,
  NotificationChannelProvider,
);

const declare = ({
  host,
  port = 443,
  period = "60s",
  email,
}: {
  readonly host: string;
  readonly port?: number;
  readonly period?: UptimeCheckProps["period"];
  readonly email?: string;
}) =>
  Effect.gen(function* () {
    const check = yield* UptimeCheck("Readiness", {
      project,
      displayName: checkName,
      host,
      port,
      period,
    });
    const channel =
      email === undefined
        ? undefined
        : yield* NotificationChannel("Email", { project, displayName: emailName, email });
    yield* AlertPolicy("Alert", {
      project,
      displayName: "example-staging HTTPS readiness failure",
      condition: check.resourceId.pipe(
        Output.map((checkId) => ({
          displayName: "Multiple failed checks",
          conditionThreshold: {
            filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="${checkId}"`,
            aggregations: [
              {
                alignmentPeriod: "300s",
                perSeriesAligner: "ALIGN_NEXT_OLDER",
                crossSeriesReducer: "REDUCE_COUNT_FALSE",
              },
            ],
            comparison: "COMPARISON_GT",
            thresholdValue: 1,
            duration: "120s",
            trigger: { count: 1 },
          },
        })),
      ),
      notificationChannels: channel?.name.pipe(Output.map((name) => [name])) ?? [],
    });
  });

function deployWithMonitoringApi(api: ReturnType<typeof monitoringApi>) {
  const state = State.inMemoryState();
  const authenticated = providers.pipe(
    Layer.provideMerge(
      Layer.merge(
        fromAccessToken({ accessToken: Redacted.make("test-token"), project }),
        Layer.succeed(HttpClient.HttpClient, api.client),
      ),
    ),
  );
  return (resources: Effect.Effect<void, never, Effect.Services<ReturnType<typeof declare>>>) =>
    Effect.gen(function* () {
      const compiled = yield* Stack.Stack(
        "MonitoringTest",
        { state, providers: authenticated },
        resources,
      );
      return yield* Effect.gen(function* () {
        const plan = yield* Plan.make(compiled);
        return yield* Apply.apply(plan).pipe(Effect.as(plan.resources));
      }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
    }).pipe(
      Effect.provideService(Stage, "test"),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
      Effect.scoped,
    );
}

test("Alchemy updates allowed fields, swaps check generations, detaches email, and deletes in dependency order", async () => {
  const api = monitoringApi();
  const deploy = (props: Parameters<typeof declare>[0]) =>
    deployWithState(declare(props)).pipe(Effect.map((resources) => resources["Readiness"]?.action));
  const deployWithState = deployWithMonitoringApi(api);

  await Effect.runPromise(
    Effect.gen(function* () {
      const initialDeploy = yield* deploy({ host: "first.example.com", email: "ops@example.com" });
      expect(initialDeploy).toBe("create");
      const created = Option.getOrUndefined(
        Arr.findFirst(
          api.requests,
          ({ method, path }) => method === "POST" && Str.endsWith("uptimeCheckConfigs")(path),
        ),
      );
      expect(created?.body).toMatchObject({
        userLabels: {
          "alchemy-stack": "monitoringtest",
          "alchemy-stage": "test",
          "alchemy-id": "readiness",
          "alchemy-instance": expect.any(String),
        },
        monitoredResource: {
          type: "uptime_url",
          labels: { host: "first.example.com", project_id: project },
        },
        period: "60s",
        httpCheck: {
          port: 443,
          useSsl: true,
          validateSsl: true,
          path: "/readyz",
          acceptedResponseStatusCodes: [{ statusValue: 200 }],
        },
        contentMatchers: [
          {
            matcher: "MATCHES_JSON_PATH",
            content: encodeJson("ok"),
            jsonPathMatcher: { jsonPath: "$.status", jsonMatcher: "EXACT_MATCH" },
          },
        ],
      });
      const alert = Option.getOrUndefined(
        Arr.findFirst([...api.resources.values()], (body) => Arr.isArray(body["conditions"])),
      );
      if (!Arr.isArray(alert?.["conditions"])) throw new Error("Expected an alert condition");
      const firstCondition = alert["conditions"][0];
      const updatedPolicy = yield* deploy({
        host: "first.example.com",
        email: "alerts@example.com",
        port: 8443,
      });
      expect(updatedPolicy).toBe("update");
      Arr.findFirst(
        api.requests,
        ({ method, path }) => method === "PATCH" && Str.includes("/uptimeCheckConfigs/")(path),
      )
        .pipe(Option.getOrUndefined, expect)
        .toMatchObject({ mask: "httpCheck", body: { httpCheck: { port: 8443 } } });
      Arr.findFirst(
        api.requests,
        ({ method, path }) => method === "PATCH" && Str.includes("/notificationChannels/")(path),
      )
        .pipe(Option.getOrUndefined, expect)
        .toMatchObject({
          mask: "labels",
          body: { labels: { email_address: "alerts@example.com" } },
        });

      const beforeReplace = api.requests.length;
      const replacedPolicy = yield* deploy({ host: "second.example.com" });
      expect(replacedPolicy).toBe("replace");
      const writes = Arr.filter(
        api.requests.slice(beforeReplace),
        ({ method }) => method !== "GET",
      );
      const newCheck = Option.getOrElse(
        Arr.findFirstIndex(
          writes,
          ({ method, path }) => method === "POST" && Str.endsWith("uptimeCheckConfigs")(path),
        ),
        () => -1,
      );
      const repoint = Option.getOrElse(
        Arr.findFirstIndex(
          writes,
          ({ method, path }) => method === "PATCH" && Str.includes("/alertPolicies/")(path),
        ),
        () => -1,
      );
      const oldCheck = Option.getOrElse(
        Arr.findFirstIndex(
          writes,
          ({ method, path }) => method === "DELETE" && Str.includes("/uptimeCheckConfigs/")(path),
        ),
        () => -1,
      );
      const oldChannel = Option.getOrElse(
        Arr.findFirstIndex(
          writes,
          ({ method, path }) => method === "DELETE" && Str.includes("/notificationChannels/")(path),
        ),
        () => -1,
      );
      expect(newCheck).toBeGreaterThanOrEqual(0);
      expect(repoint).toBeGreaterThan(newCheck);
      expect(oldCheck).toBeGreaterThan(repoint);
      expect(oldChannel).toBeGreaterThan(repoint);
      expect(writes[repoint]?.body).toMatchObject({
        conditions: [
          {
            name: Predicate.isObject(firstCondition)
              ? Reflect.get(firstCondition, "name")
              : undefined,
          },
        ],
        notificationChannels: [],
      });

      const beforeNoop = api.requests.length;
      const unchangedPolicy = yield* deploy({ host: "second.example.com" });
      expect(unchangedPolicy).toBe("noop");
      expect(Arr.every(api.requests.slice(beforeNoop), ({ method }) => method === "GET")).toBe(
        true,
      );
      const replacedPeriod = yield* deploy({ host: "second.example.com", period: "300s" });
      expect(replacedPeriod).toBe("replace");
      yield* deployWithState(Effect.void);
      expect([...api.resources.keys()]).toEqual([]);
    }),
  );
}, 60_000);

test("Alchemy adopts a matching generated ID across list pages after a lost create answer", async () => {
  const api = monitoringApi({ loseFirstCreate: true, disabledOnFirstRead: true });
  const deploy = deployWithMonitoringApi(api);
  const declareEmail = NotificationChannel("Email", {
    project,
    displayName: emailName,
    email: "ops@example.com",
  }).pipe(Effect.asVoid);
  const unrelated = `projects/${project}/notificationChannels/existing`;
  api.resources.set(unrelated, { displayName: "unrelated email", name: unrelated, type: "email" });

  await declareEmail.pipe(deploy, Effect.runPromise, expect).rejects.toBeDefined();
  await Fn.pipe(deploy(declareEmail), Effect.runPromise);
  expect(Arr.filter(api.requests, ({ method }) => method === "POST")).toHaveLength(1);
  expect(api.resources.size).toBe(2);

  await Fn.pipe(deploy(Effect.void), Effect.runPromise);
  expect([...api.resources.keys()]).toEqual([unrelated]);
});

test("Alchemy recovers a lost successor create and retains the predecessor until the alert is valid", async () => {
  const api = monitoringApi();
  const deploy = deployWithMonitoringApi(api);
  await Fn.pipe(deploy(declare({ host: "first.example.com" })), Effect.runPromise);
  const next = declare({ host: "second.example.com" });
  const attemptsBeforeCutover = api.requests.length;
  api.faults.loseNextCreate = true;
  await next.pipe(deploy, Effect.runPromise, expect).rejects.toThrow("HTTP 503");
  api.faults.invalidPolicyPatch = true;
  await next.pipe(deploy, Effect.runPromise, expect).rejects.toThrow("alert policy is invalid");
  const failedAttempt = api.requests.slice(attemptsBeforeCutover);
  expect(Arr.some(failedAttempt, ({ method }) => method === "DELETE")).toBe(false);
  expect(
    Arr.filter([...api.resources.keys()], (name) => Str.includes("/uptimeCheckConfigs/")(name)),
  ).toHaveLength(2);

  await Fn.pipe(deploy(next), Effect.runPromise);
  const checkCreates = Arr.filter(
    api.requests,
    ({ method, path }) => method === "POST" && Str.endsWith("uptimeCheckConfigs")(path),
  );
  expect(checkCreates).toHaveLength(2);
  expect(checkCreates[0]?.body["userLabels"]).not.toEqual(checkCreates[1]?.body["userLabels"]);
  expect(
    Arr.filter([...api.resources.keys()], (name) => Str.includes("/uptimeCheckConfigs/")(name)),
  ).toHaveLength(1);
}, 60_000);

test("Alchemy refuses ambiguous display-name matches without issuing a POST", async () => {
  const api = monitoringApi();
  const deploy = deployWithMonitoringApi(api);
  for (const id of ["foreign-one", "foreign-two"]) {
    const name = `projects/${project}/notificationChannels/${id}`;
    api.resources.set(name, { name, displayName: emailName, type: "email" });
  }
  const email = NotificationChannel("Email", {
    project,
    displayName: emailName,
    email: "ops@example.com",
  });
  await email
    .pipe(Effect.asVoid, deploy, Effect.runPromise, expect)
    .rejects.toThrow("multiple resources match");
  expect(Arr.every(api.requests, ({ method }) => method === "GET")).toBe(true);
});

test("fresh state adopts the readiness policy and clears per-location grouping without changing its condition ID", async () => {
  const api = monitoringApi();
  const resources = declare({ host: "first.example.com" });
  await Fn.pipe(deployWithMonitoringApi(api)(resources), Effect.runPromise);
  const policy = Option.getOrUndefined(
    Arr.findFirst([...api.resources.values()], (body) => Arr.isArray(body["conditions"])),
  );
  if (!Arr.isArray(policy?.["conditions"])) throw new Error("Expected a readiness alert policy");
  const [condition] = policy["conditions"];
  const aggregation = Schema.decodeUnknownResult(
    Schema.Struct({
      conditionThreshold: Schema.Struct({
        aggregations: Schema.NonEmptyArray(Schema.ObjectKeyword),
      }),
    }),
  )(condition).pipe(Result.getOrThrow).conditionThreshold.aggregations[0];
  Reflect.set(aggregation, "groupByFields", ["metric.label.checker_location"]);
  const beforeAdoption = api.requests.length;

  await Fn.pipe(deployWithMonitoringApi(api)(resources), Effect.runPromise);
  const writes = Arr.filter(api.requests.slice(beforeAdoption), ({ method }) => method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: "PATCH",
    mask: "conditions",
    body: {
      conditions: [
        {
          name: Predicate.isObject(condition) ? Reflect.get(condition, "name") : undefined,
        },
      ],
    },
  });
  expect(encodeJson(writes[0]?.body)).not.toContain("groupByFields");
}, 60_000);
