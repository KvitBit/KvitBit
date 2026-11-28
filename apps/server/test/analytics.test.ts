import { expect, mock, test } from "bun:test";
import { WorkspaceId } from "@kvitbit/domain/contract";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { PostHogConfig } from "../src/config";
import { Analytics, makeAnalyticsLayer } from "../src/runtime/analytics";
import { captureAnalytics, posthogSettings } from "./analytics-fixture";

const distinctIdPattern = /^[a-f\d-]{36}$/;

const readConfig = (env: Record<string, string>) =>
  Effect.runPromise(PostHogConfig.parse(ConfigProvider.fromEnv({ env })));

test("validates optional PostHog settings and defaults to EU ingestion", async () => {
  expect(await readConfig({})).toBeNull();
  expect(await readConfig({ KVITBIT_POSTHOG_KEY: "  " })).toBeNull();
  expect(await readConfig({ KVITBIT_POSTHOG_KEY: "  phc_test  " })).toEqual(posthogSettings);
  expect(
    await readConfig({
      KVITBIT_POSTHOG_KEY: "phc_test",
      KVITBIT_POSTHOG_HOST: "https://proxy.example.test",
    }),
  ).toEqual({
    ...posthogSettings,
    host: "https://proxy.example.test",
  });
  for (const key of ["phc_", "phx_test", "phc_test with whitespace"]) {
    await expect(readConfig({ KVITBIT_POSTHOG_KEY: key })).rejects.toThrow("KVITBIT_POSTHOG_KEY");
  }
  for (const host of [
    "http://proxy.example.test",
    "https:proxy.example.test",
    "not-a-url",
    "https://user:password@proxy.example.test",
  ]) {
    await expect(
      readConfig({ KVITBIT_POSTHOG_KEY: "phc_test", KVITBIT_POSTHOG_HOST: host }),
    ).rejects.toThrow("KVITBIT_POSTHOG_HOST");
  }
});

test("disabled analytics never constructs a PostHog client", async () => {
  const makeClient = mock((): never => {
    throw new Error("unexpected SDK initialization");
  });
  await Effect.runPromise(
    Effect.flatMap(Analytics, (analytics) =>
      analytics.capture({ event: "share_link_opened" }),
    ).pipe(Effect.provide(makeAnalyticsLayer(null, makeClient))),
  );
  expect(makeClient).not.toHaveBeenCalled();
});

test("analytics allowlists event fields, validates IDs, and awaits the SDK flush on scope exit", async () => {
  const { layer, capture, shutdown } = captureAnalytics();
  const userId = "01900000-0000-7000-8000-000000000001";
  const workspaceId = WorkspaceId.make("01900000-0000-7000-8000-000000000002");
  const privateData = {
    email: "customer@example.test",
    name: "Customer Name",
    password: "test-password",
    token: "test-bearer-or-share-token",
    lines: [{ amount: 399, description: "Private invoice line" }],
  };
  let captureCountAtShutdown = 0;
  shutdown.mockImplementation(async () => {
    await Effect.runPromise(Effect.yieldNow);
    captureCountAtShutdown = capture.mock.calls.length;
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      yield* analytics.capture({
        ...privateData,
        event: "document_issued",
        userId,
        workspaceId,
        kind: "invoice",
        source: "draft",
      });
      yield* analytics.capture({
        event: "user_signed_up",
        userId: privateData.email,
        method: "email",
      });
      yield* analytics.capture({
        ...privateData,
        event: "document_draft_saved",
        userId,
        workspaceId,
        kind: "invoice",
        mode: "created",
      });
      yield* analytics.capture({
        ...privateData,
        event: "expense_receipt_uploaded",
        userId,
        workspaceId,
      });
      yield* analytics.capture({
        ...privateData,
        event: "contact_saved",
        userId,
        workspaceId,
        mode: "updated",
      });
      yield* analytics.capture({
        ...privateData,
        event: "api_key_created",
        userId,
        workspaceId,
        access: "read_write",
      });
      yield* analytics.capture({
        ...privateData,
        event: "api_key_revoked",
        userId,
        workspaceId,
        access: "custom",
      });
      yield* analytics.capture({
        ...privateData,
        event: "team_invitation_sent",
        userId,
        workspaceId,
        role: "member",
      });
      yield* analytics.capture({
        ...privateData,
        event: "report_exported",
        userId,
        workspaceId,
        report: "revenue",
        format: "csv",
      });
      yield* analytics.capture({ ...privateData, event: "share_link_opened" });
      expect(shutdown).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  expect(capture.mock.calls).toEqual([
    [
      {
        event: "document_issued",
        distinctId: userId,
        properties: { workspaceId, kind: "invoice", source: "draft" },
      },
    ],
    [
      {
        event: "document_draft_saved",
        distinctId: userId,
        properties: { workspaceId, kind: "invoice", mode: "created" },
      },
    ],
    [
      {
        event: "expense_receipt_uploaded",
        distinctId: userId,
        properties: { workspaceId },
      },
    ],
    [
      {
        event: "contact_saved",
        distinctId: userId,
        properties: { workspaceId, mode: "updated" },
      },
    ],
    [
      {
        event: "api_key_created",
        distinctId: userId,
        properties: { workspaceId, access: "read_write" },
      },
    ],
    [
      {
        event: "api_key_revoked",
        distinctId: userId,
        properties: { workspaceId, access: "custom" },
      },
    ],
    [
      {
        event: "team_invitation_sent",
        distinctId: userId,
        properties: { workspaceId, role: "member" },
      },
    ],
    [
      {
        event: "report_exported",
        distinctId: userId,
        properties: { workspaceId, report: "revenue", format: "csv" },
      },
    ],
    [
      {
        event: "share_link_opened",
        distinctId: expect.stringMatching(distinctIdPattern),
        options: { process_person_profile: false },
      },
    ],
  ]);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(captureCountAtShutdown).toBe(capture.mock.calls.length);
});
