import { ConfigView } from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { apiOrigin, ROUTE_BASE } from "../config/env";
import { createPageviewTracker } from "./analytics";
import { fromMobilePromise, runMobileEffect } from "./request-intent";

let track: ReturnType<typeof createPageviewTracker> | undefined;

const loadAnalyticsConfig = Effect.gen(function* () {
  const fetch = yield* FetchHttpClient.Fetch;
  const response = yield* fromMobilePromise(() =>
    fetch(`${apiOrigin()}/api/v1/config`, { signal: AbortSignal.timeout(10_000) }),
  );
  if (!response.ok) return;
  const body: unknown = yield* fromMobilePromise(() => response.json());
  const config = yield* Schema.decodeUnknownEffect(ConfigView)(body);
  return config.analytics;
}).pipe(Effect.orElseSucceed(() => undefined));

const loadConfig = () => runMobileEffect(loadAnalyticsConfig);

export const trackWebPageview = (pathname: string): void => {
  const location = globalThis.location;
  if (location === undefined) return;
  track ??= createPageviewTracker({ origin: location.origin, loadConfig });
  track(Str.slice(0, -1)(ROUTE_BASE) + pathname);
};
