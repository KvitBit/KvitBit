import { expect, test } from "bun:test";
import { fromAccessToken } from "@alchemy.run/gcp";
import * as Apply from "alchemy/Apply";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import {
  AlertPolicy,
  AlertPolicyProvider,
  NotificationChannel,
  NotificationChannelProvider,
  UptimeCheck,
  type UptimeCheckProps,
  UptimeCheckProvider,
} from "../src/resources/monitoring-provider";

type Body = Record<string, unknown>;
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
      expect(url.origin).toBe("https://monitoring.googleapis.com");
      expect(request.headers.authorization).toBe("Bearer test-token");
      const path = url.pathname.replace(/^\/v3\//, "");
      const [projectSegment, projectId, collection, id] = path.split("/");
      expect(projectSegment).toBe("projects");
      expect(projectId).toBe(project);
      const body: Body =
        request.body._tag === "Uint8Array" ? JSON.parse(request.body.text ?? "") : {};
      const mask = url.searchParams.get("updateMask");
      requests.push({ method: request.method, path, mask, body });
      const reply = (response: unknown = {}, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(response, { status }));
      const current = resources.get(path);

      if (request.method === "GET" && collection) {
        if (disabled) {
          disabled = false;
          return reply({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, 403);
        }
        if (id) return current ? reply(current) : reply({}, 404);
        const candidates = [...resources.entries()]
          .filter(([name]) => name.startsWith(`${path}/`))
          .map(([, value]) => value);
        // One item per page to exercise interrupted-create recovery across pages.
        const index = Number(url.searchParams.get("pageToken") ?? 0);
        return reply({
          [collection]: candidates.slice(index, index + 1),
          ...(index + 1 < candidates.length ? { nextPageToken: String(index + 1) } : {}),
        });
      }
      if (request.method === "POST") {
        expect(body.name).toBeUndefined();
        const name = `${path}/${++nextId}`;
        const created: Body = { ...body, name };
        if (Array.isArray(created.conditions)) {
          created.conditions = created.conditions.map((condition) => ({
            ...condition,
            name: `${name}/conditions/1`,
          }));
        }
        resources.set(name, created);
        if (faults.loseNextCreate) {
          faults.loseNextCreate = false;
          return reply({}, 503);
        }
        return reply(created);
      }
      if (request.method === "PATCH" && current) {
        expect(body.name).toBe(path);
        expect(mask?.split(",").sort()).toEqual(
          Object.keys(body)
            .filter((key) => key !== "name")
            .sort(),
        );
        if (collection === "uptimeCheckConfigs") {
          expect(
            Object.keys(body).every((key) =>
              ["name", "displayName", "httpCheck", "timeout", "contentMatchers"].includes(key),
            ),
          ).toBe(true);
        }
        const patched = { ...current, ...body };
        if (collection === "alertPolicies" && faults.invalidPolicyPatch) {
          faults.invalidPolicyPatch = false;
          return reply({ ...patched, validity: { code: 3 } });
        }
        resources.set(path, patched);
        return reply(patched);
      }
      if (request.method === "DELETE") {
        expect(url.searchParams.get("force")).toBeNull();
        for (const policy of resources.values()) {
          if (collection === "uptimeCheckConfigs" && id && Array.isArray(policy.conditions)) {
            if (JSON.stringify(policy.conditions).includes(`check_id=\\"${id}\\"`))
              return reply({}, 400);
          }
          if (collection === "notificationChannels" && Array.isArray(policy.notificationChannels)) {
            if (policy.notificationChannels.includes(path)) return reply({}, 400);
          }
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
        yield* Apply.apply(plan);
        return plan.resources;
      }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
    }).pipe(
      Effect.provideService(Stage, "test"),
      Effect.provideService(MinimumLogLevel, "Warn"),
      Effect.scoped,
    );
}

test("Alchemy updates allowed fields, swaps check generations, detaches email, and deletes in dependency order", async () => {
  const api = monitoringApi();
  const deploy = (props: Parameters<typeof declare>[0]) =>
    deployWithState(declare(props)).pipe(Effect.map((resources) => resources.Readiness?.action));
  const deployWithState = deployWithMonitoringApi(api);

  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* deploy({ host: "first.example.com", email: "ops@example.com" })).toBe("create");
      const created = api.requests.find(
        ({ method, path }) => method === "POST" && path.endsWith("uptimeCheckConfigs"),
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
            content: "ok",
            jsonPathMatcher: { jsonPath: "$.status", jsonMatcher: "EXACT_MATCH" },
          },
        ],
      });
      const alert = [...api.resources.values()].find((body) => Array.isArray(body.conditions));
      if (!Array.isArray(alert?.conditions)) throw new Error("Expected an alert condition");
      const firstCondition = alert.conditions[0];
      expect(
        yield* deploy({ host: "first.example.com", email: "alerts@example.com", port: 8443 }),
      ).toBe("update");
      expect(
        api.requests.find(
          ({ method, path }) => method === "PATCH" && path.includes("/uptimeCheckConfigs/"),
        ),
      ).toMatchObject({ mask: "httpCheck", body: { httpCheck: { port: 8443 } } });
      expect(
        api.requests.find(
          ({ method, path }) => method === "PATCH" && path.includes("/notificationChannels/"),
        ),
      ).toMatchObject({
        mask: "labels",
        body: { labels: { email_address: "alerts@example.com" } },
      });

      const beforeReplace = api.requests.length;
      expect(yield* deploy({ host: "second.example.com" })).toBe("replace");
      const writes = api.requests.slice(beforeReplace).filter(({ method }) => method !== "GET");
      const newCheck = writes.findIndex(
        ({ method, path }) => method === "POST" && path.endsWith("uptimeCheckConfigs"),
      );
      const repoint = writes.findIndex(
        ({ method, path }) => method === "PATCH" && path.includes("/alertPolicies/"),
      );
      const oldCheck = writes.findIndex(
        ({ method, path }) => method === "DELETE" && path.includes("/uptimeCheckConfigs/"),
      );
      const oldChannel = writes.findIndex(
        ({ method, path }) => method === "DELETE" && path.includes("/notificationChannels/"),
      );
      expect(newCheck).toBeGreaterThanOrEqual(0);
      expect(repoint).toBeGreaterThan(newCheck);
      expect(oldCheck).toBeGreaterThan(repoint);
      expect(oldChannel).toBeGreaterThan(repoint);
      expect(writes[repoint]?.body).toMatchObject({
        conditions: [{ name: firstCondition?.name }],
        notificationChannels: [],
      });

      const beforeNoop = api.requests.length;
      expect(yield* deploy({ host: "second.example.com" })).toBe("noop");
      expect(api.requests.slice(beforeNoop).every(({ method }) => method === "GET")).toBe(true);
      expect(yield* deploy({ host: "second.example.com", period: "300s" })).toBe("replace");
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

  await expect(Effect.runPromise(deploy(declareEmail))).rejects.toBeDefined();
  await Effect.runPromise(deploy(declareEmail));
  expect(api.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  expect(api.resources.size).toBe(2);

  await Effect.runPromise(deploy(Effect.void));
  expect([...api.resources.keys()]).toEqual([unrelated]);
});

test("Alchemy recovers a lost successor create and retains the predecessor until the alert is valid", async () => {
  const api = monitoringApi();
  const deploy = deployWithMonitoringApi(api);
  await Effect.runPromise(deploy(declare({ host: "first.example.com" })));
  const next = declare({ host: "second.example.com" });
  const attemptsBeforeCutover = api.requests.length;
  api.faults.loseNextCreate = true;
  await expect(Effect.runPromise(deploy(next))).rejects.toThrow("HTTP 503");
  api.faults.invalidPolicyPatch = true;
  await expect(Effect.runPromise(deploy(next))).rejects.toThrow("alert policy is invalid");
  const failedAttempt = api.requests.slice(attemptsBeforeCutover);
  expect(failedAttempt.some(({ method }) => method === "DELETE")).toBe(false);
  expect(
    [...api.resources.keys()].filter((name) => name.includes("/uptimeCheckConfigs/")),
  ).toHaveLength(2);

  await Effect.runPromise(deploy(next));
  const checkCreates = api.requests.filter(
    ({ method, path }) => method === "POST" && path.endsWith("uptimeCheckConfigs"),
  );
  expect(checkCreates).toHaveLength(2);
  expect(checkCreates[0]?.body.userLabels).not.toEqual(checkCreates[1]?.body.userLabels);
  expect(
    [...api.resources.keys()].filter((name) => name.includes("/uptimeCheckConfigs/")),
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
  await expect(Effect.runPromise(deploy(email.pipe(Effect.asVoid)))).rejects.toThrow(
    "multiple resources match",
  );
  expect(api.requests.every(({ method }) => method === "GET")).toBe(true);
});

test("fresh state adopts the readiness policy and clears per-location grouping without changing its condition ID", async () => {
  const api = monitoringApi();
  const resources = declare({ host: "first.example.com" });
  await Effect.runPromise(deployWithMonitoringApi(api)(resources));
  const policy = [...api.resources.values()].find((body) => Array.isArray(body.conditions));
  if (!Array.isArray(policy?.conditions)) throw new Error("Expected a readiness alert policy");
  const [condition] = policy.conditions;
  condition.conditionThreshold.aggregations[0].groupByFields = ["metric.label.checker_location"];
  const beforeAdoption = api.requests.length;

  await Effect.runPromise(deployWithMonitoringApi(api)(resources));
  const writes = api.requests.slice(beforeAdoption).filter(({ method }) => method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: "PATCH",
    mask: "conditions",
    body: { conditions: [{ name: condition.name }] },
  });
  expect(JSON.stringify(writes[0]?.body)).not.toContain("groupByFields");
}, 60_000);
