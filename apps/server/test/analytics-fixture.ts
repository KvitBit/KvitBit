import { mock } from "bun:test";
import type { EventMessage } from "posthog-node";
import { makeAnalyticsLayer } from "../src/runtime/analytics";

export const posthogSettings = { apiKey: "phc_test", host: "https://eu.i.posthog.com" };

export const captureAnalytics = () => {
  const capture = mock((_message: EventMessage) => {});
  const shutdown = mock(async () => {});
  const on = mock(() => () => {});
  const layer = makeAnalyticsLayer(posthogSettings, () => ({ capture, on, shutdown }));
  return { layer, capture, shutdown, on };
};
