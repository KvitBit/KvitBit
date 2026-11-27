import { expect, mock, test } from "bun:test";
import type { PostHogConfig, Properties } from "posthog-js/dist/module.slim.no-external.js";
import { createPageviewTracker } from "../src/app/analytics";

const origin = "https://kvitbit.test";
const apiKey = "phc_test";
const host = "https://eu.i.posthog.com";
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("initializes once and captures only sanitized pageviews", async () => {
  const init = mock((_key: string, _options: Partial<PostHogConfig>) => undefined);
  const capture = mock((_event: "$pageview", _properties: Properties) => undefined);
  const loadConfig = mock(async () => ({ posthog: { apiKey, host } }));
  const loadSdk = mock(async () => ({ init, capture }));
  const track = createPageviewTracker(origin, loadConfig, loadSdk);

  track("/i/short-secret?email=alice@example.test#fragment");
  track("/i/short-secret?different=query");
  track("/w/novak-design/documents/42/edit?tab=items");
  await nextTurn();
  track("/reset-password?token=secret");

  expect(loadConfig).toHaveBeenCalledTimes(1);
  expect(loadSdk).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledWith(
    apiKey,
    expect.objectContaining({
      api_host: host,
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
    ["/i/[token]", "/w/[id]/documents/[id]/edit", "/reset-password"].map((path) => [
      "$pageview",
      { $current_url: origin + path, $pathname: path },
    ]),
  );

  const options = init.mock.calls[0]?.[1];
  const raw = {
    $current_url: `${origin}/i/private-token?access=secret`,
    $pathname: "/s/private-token?secret#private",
    $prev_pageview_pathname: "/i/another-private-token",
    $referrer: "https://origin.test/s/private",
    $initial_current_url: "https://origin.test/w/customer/private",
    title: "Invoice 2026-0042",
    email: "alice@example.test",
  };
  const sanitized = {
    $current_url: `${origin}/s/[token]`,
    $pathname: "/s/[token]",
    token: apiKey,
    distinct_id: "$posthog_cookieless",
    $cookieless_mode: true,
    $process_person_profile: false,
    $geoip_disable: true,
  };
  expect(options?.sanitize_properties?.(raw, "$pageview")).toEqual(sanitized);
  const beforeSend = options?.before_send;
  expect(typeof beforeSend).toBe("function");
  if (typeof beforeSend === "function") {
    const uuid = "event-id";
    expect(
      beforeSend({ uuid, event: "$pageview", properties: raw, $set: { email: raw.email } }),
    ).toEqual({
      uuid,
      event: "$pageview",
      properties: sanitized,
    });
    expect(beforeSend({ uuid, event: "$autocapture", properties: raw })).toBeNull();
  }
});

test.each([undefined, { posthog: null }, {}])(
  "skips the SDK when analytics config is %p",
  async (config) => {
    const loadSdk = mock(() => Promise.reject(new Error("SDK loaded unexpectedly")));
    const loadConfig = mock(async () => config);
    const track = createPageviewTracker(origin, loadConfig, loadSdk);

    track("/sign-in?returnTo=/w/private");
    await nextTurn();
    track("/sign-up");

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadSdk).not.toHaveBeenCalled();
  },
);

test.each([
  ["/share/case", "/share/[token]"],
  ["/s/short", "/s/[token]"],
  ["/invite/maria", "/invite/[token]"],
  ["/invitations/x", "/invitations/[token]"],
  ["/auth/magic/short", "/auth/magic/[token]"],
  ["/auth/customer@example.test/short", "/auth/[kind]/[token]"],
  ["/consent/short", "/consent/[id]"],
  ["/w/customer-slug/contacts/123", "/w/[id]/contacts/[id]"],
  ["/w/john/templates/0d570ffd-78e9-438b-83a3-1f1c3a234021", "/w/[id]/templates/[id]"],
  ["/unknown/alice@example.test", "/[id]"],
  ["/75ed480c81ef90f57173615fa724cfdd2f25ceea", "/[id]"],
])("turns %s into %s before calling PostHog", async (path, expected) => {
  const capture = mock((_event: "$pageview", _properties: Properties) => undefined);
  const track = createPageviewTracker(
    origin,
    async () => ({ posthog: { apiKey, host } }),
    async () => ({ init: () => undefined, capture }),
  );

  track(`${path}?term=private#another-secret`);
  await nextTurn();

  expect(capture).toHaveBeenCalledWith("$pageview", {
    $current_url: origin + expected,
    $pathname: expected,
  });
});
