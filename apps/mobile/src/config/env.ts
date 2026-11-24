/**
 * Where the app finds its server. The PWA at `/app/` talks to its own origin; the Android build
 * bakes `EXPO_PUBLIC_API_ORIGIN` in at build time (app.config.ts checks it for release builds).
 */
const DEV_ORIGIN = "http://10.0.2.2:8080";
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/** Normalises a configured origin: absolute https, or plain http only for a local host. */
export const parseApiOrigin = (configured: string | undefined): string | null => {
  const candidate = configured?.trim();
  if (candidate === undefined || candidate === "") return null;
  const url = URL.parse(candidate);
  if (url === null) return null;
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && PLAIN_HTTP_HOSTS.has(url.hostname));
  return allowed ? url.origin : null;
};

/**
 * The API origin: the page origin on the web, else the configured origin, else the Android
 * emulator's host loopback for development.
 */
export const apiOrigin = (
  env: { readonly EXPO_PUBLIC_API_ORIGIN?: string | undefined } = {
    EXPO_PUBLIC_API_ORIGIN: process.env.EXPO_PUBLIC_API_ORIGIN,
  },
  location: { readonly origin: string } | undefined = globalThis.location,
): string => {
  if (location !== undefined && /^https?:/.test(location.origin)) return location.origin;
  return parseApiOrigin(env.EXPO_PUBLIC_API_ORIGIN) ?? DEV_ORIGIN;
};

/** The base the router mounts under (app.json `experiments.baseUrl`). */
export const ROUTE_BASE = "/app/" as const;
