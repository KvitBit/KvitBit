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
  UptimeCheckProvider,
} from "../src/resources/monitoring-provider";

type Body = Record<string, unknown>;
const project = "example-project";
const checkName = "example-staging HTTPS readiness";
const emailName = "example-staging operations email";

function monitoringApi(options: { loseFirstCreate?: boolean } = {}) {
  const resources = new Map<string, Body>();
  const requests: Array<{ method: string; path: string; mask: string | null; body: Body }> = [];
  let nextId = 0;
  let loseAnswer = options.loseFirstCreate;
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
        if (loseAnswer) {
          loseAnswer = false;
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
  return { client, requests, resources };
}

const providers = Layer.mergeAll(
  UptimeCheckProvider,
  AlertPolicyProvider,
  NotificationChannelProvider,
);

const declare = ({
  host,
  port = 443,
  email,
}: {
  readonly host: string;
  readonly port?: number;
  readonly email?: string;
}) =>
  Effect.gen(function* () {
    const check = yield* UptimeCheck("Readiness", {
      project,
      displayName: checkName,
      host,
      port,
      period: "60s",
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
      yield* deployWithState(Effect.void);
      expect([...api.resources.keys()]).toEqual([]);
    }),
  );
});

test("Alchemy adopts a matching generated ID across list pages after a lost create answer", async () => {
  const api = monitoringApi({ loseFirstCreate: true });
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
