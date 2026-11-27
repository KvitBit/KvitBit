import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { runMobileSync } from "../runtime/request-intent";

/**
 * Where the app finds its server. The PWA at `/app/` talks to its own origin; the Android build
 * bakes `EXPO_PUBLIC_API_ORIGIN` in at build time (app.config.ts checks it for release builds).
 */
const DEV_ORIGIN = "http://10.0.2.2:8080";
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/** Normalises a configured origin: absolute https, or plain http only for a local host. */
export const parseApiOrigin = (configured: string | undefined): string | null => {
  const candidate = Str.trim(configured ?? "");
  if (candidate === "") return null;
  const url = Effect.try({
    try: () => new URL(candidate),
    catch: () => "InvalidApiOrigin" as const,
  }).pipe(
    Effect.orElseSucceed(() => null),
    runMobileSync,
  );
  if (url === null) return null;
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && PLAIN_HTTP_HOSTS.has(url.hostname));
  return allowed ? url.origin : null;
};

/**
 * The API origin: the page origin on the web, else the configured origin, else the Android
 * emulator's host loopback for development.
 */
const pageOrigin = /^https?:/;

interface ApiOriginOptions {
  readonly env?: { readonly EXPO_PUBLIC_API_ORIGIN?: string | undefined };
  readonly location?: { readonly origin: string } | undefined;
}

export const apiOrigin = (options: ApiOriginOptions = {}): string => {
  const { env = { EXPO_PUBLIC_API_ORIGIN: process.env.EXPO_PUBLIC_API_ORIGIN } } = options;
  const location = "location" in options ? options.location : globalThis.location;
  if (location !== undefined && pageOrigin.test(location.origin)) return location.origin;
  return parseApiOrigin(env.EXPO_PUBLIC_API_ORIGIN) ?? DEV_ORIGIN;
};
