import { ConfigView } from "@kvitbit/api-contract";
import { Option, Schema } from "effect";
import { apiOrigin, ROUTE_BASE } from "../config/env";
import { createPageviewTracker } from "./analytics";

const decodeConfig = Schema.decodeUnknownOption(ConfigView);
let track: ReturnType<typeof createPageviewTracker> | undefined;

export const trackWebPageview = (pathname: string): void => {
  if (typeof location === "undefined") return;

  track ??= createPageviewTracker(location.origin, async () => {
    const response = await fetch(`${apiOrigin()}/api/v1/config`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    return Option.getOrUndefined(decodeConfig(await response.json()))?.analytics;
  });
  track(ROUTE_BASE.slice(0, -1) + pathname);
};
