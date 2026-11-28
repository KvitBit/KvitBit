import { expect, mock, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { PostHogConfig, Properties } from "posthog-js/dist/module.slim.no-external.js";
import { createPageviewTracker } from "./analytics";

const origin = "https://kvitbit.test";
const apiKey = "phc_test";
const host = "/_kvb";
const resolvedHost = `${origin}${host}`;
const nextTurn = () => Effect.runPromise(Effect.sleep(1));

test("initializes once and captures only sanitized pageviews", async () => {
  const init = mock((_key: string, _options: Partial<PostHogConfig>) => undefined);
  const capture = mock((_event: "$pageview", _properties: Properties) => undefined);
  const loadConfig = mock(async () => ({ posthog: { apiKey, host } }));
  const loadSdk = mock(async () => ({ init, capture }));
  const track = createPageviewTracker({ origin, loadConfig, loadSdk });

  track("/app/i/short-secret?email=alice@example.test#fragment");
  track("/app/i/short-secret?different=query");
  track("/app/w/novak-design/documents/42/edit?tab=items");
  await nextTurn();
  track("/app/reset-password?token=secret");

  expect(loadConfig).toHaveBeenCalledTimes(1);
  expect(loadSdk).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledWith(
    apiKey,
    expect.objectContaining({
      api_host: resolvedHost,
      persistence: "memory",
      cookieless_mode: "always",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      person_profiles: "never",
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
    }),
  );
  expect(capture.mock.calls).toEqual(
    Arr.map(
      ["/app/i/[token]", "/app/w/[id]/documents/[id]/edit", "/app/reset-password"],
      (path) => ["$pageview", { $current_url: origin + path, $pathname: path }],
    ),
  );

  const options = init.mock.calls[0]?.[1];
  const raw = {
    $current_url: `${origin}/i/private-token?access=secret`,
    $pathname: "/app/s/private-token?secret#private",
    $prev_pageview_pathname: "/i/another-private-token",
    $referrer: "https://origin.test/s/private",
    $initial_current_url: "https://origin.test/w/customer/private",
    title: "Invoice 2026-0042",
    email: "alice@example.test",
  };
  const sanitized = {
    $current_url: `${origin}/app/s/[token]`,
    $pathname: "/app/s/[token]",
    token: apiKey,
    distinct_id: "$posthog_cookieless",
    $cookieless_mode: true,
    $process_person_profile: false,
    $geoip_disable: true,
  };
  expect(options?.sanitize_properties?.(raw, "$pageview")).toEqual(sanitized);
  const beforeSend = options?.before_send;
  expect(Predicate.isFunction(beforeSend)).toBe(true);
  if (!Predicate.isFunction(beforeSend)) throw new Error("Expected the asserted result");
  const uuid = "event-id";
  expect(
    beforeSend({ uuid, event: "$pageview", properties: raw, $set: { email: raw.email } }),
  ).toEqual({
    uuid,
    event: "$pageview",
    properties: sanitized,
  });
  expect(beforeSend({ uuid, event: "$autocapture", properties: raw })).toBeNull();
});

test.each([undefined, { posthog: null }, {}])(
  "skips the SDK when analytics config is %p",
  async (config) => {
    const loadSdk = mock(() => Promise.reject(new Error("SDK loaded unexpectedly")));
    const loadConfig = mock(async () => config);
    const track = createPageviewTracker({ origin, loadConfig, loadSdk });

    track("/app/sign-in?returnTo=/w/private");
    await nextTurn();
    track("/app/sign-up");

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadSdk).not.toHaveBeenCalled();
  },
);

test.each([
  ["/app/share/case", "/app/share/[token]"],
  ["/app/s/short", "/app/s/[token]"],
  ["/app/invite/maria", "/app/invite/[token]"],
  ["/app/invitations/x", "/app/invitations/[token]"],
  ["/app/auth/magic/short", "/app/auth/magic/[token]"],
  ["/app/auth/customer@example.test/short", "/app/auth/[kind]/[token]"],
  ["/app/consent/short", "/app/consent/[id]"],
  ["/app/w/customer-slug/contacts/123", "/app/w/[id]/contacts/[id]"],
  ["/app/w/john/templates/0d570ffd-78e9-438b-83a3-1f1c3a234021", "/app/w/[id]/templates/[id]"],
  ["/app/unknown/alice@example.test", "/app/[id]"],
  ["/app/75ed480c81ef90f57173615fa724cfdd2f25ceea", "/app/[id]"],
])("turns %s into %s before calling PostHog", async (path, expected) => {
  const capture = mock((_event: "$pageview", _properties: Properties) => undefined);
  const track = createPageviewTracker({
    origin,
    loadConfig: async () => ({ posthog: { apiKey, host } }),
    loadSdk: async () => ({ init: () => undefined, capture }),
  });

  track(`${path}?term=private#another-secret`);
  await nextTurn();

  expect(capture).toHaveBeenCalledWith("$pageview", {
    $current_url: origin + expected,
    $pathname: expected,
  });
});
