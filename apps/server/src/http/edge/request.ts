/** Request facts the edge derives from headers and the connection (sections 1, 2.4). */
import type { Locale } from "@kvitbit/domain/contract";
import { Option } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

/**
 * Client address: the entry `hops` places from the right of `X-Forwarded-For` (each trusted
 * proxy appends the address it saw), else the socket address. With `hops = 0` the header is
 * ignored.
 */
export const clientIp = (request: HttpServerRequest, hops: number): string => {
  const forwarded = request.headers["x-forwarded-for"];
  if (hops > 0 && forwarded !== undefined) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const entry = entries[entries.length - hops] ?? entries[0];
    if (entry !== undefined) return entry;
  }
  return Option.getOrElse(request.remoteAddress, () => "unknown");
};

const SUPPORTED: ReadonlyArray<Locale> = ["cs", "en"];

/**
 * First supported language of an `Accept-Language` header by quality (`cs` or `en`), else
 * undefined. Region subtags count for their language (`en-GB` is `en`).
 */
export const acceptLanguageLocale = (header: string | undefined): Locale | undefined => {
  if (header === undefined) return undefined;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number(q);
      return {
        language: tag.toLowerCase().split("-")[0] ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const entry of ranked) {
    const locale = SUPPORTED.find((supported) => supported === entry.language);
    if (locale !== undefined) return locale;
  }
  return undefined;
};

/** Principal locale rule (section 2.4): preference, else Accept-Language, else `cs`. */
export const resolveLocale = (
  preference: Locale | null | undefined,
  acceptLanguage: string | undefined,
): Locale => preference ?? acceptLanguageLocale(acceptLanguage) ?? "cs";

/** The bearer value of an `Authorization` header, if any. */
export const bearerToken = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(authorization);
  return match?.[1];
};

/** A body-less web `Request` carrying the headers of `request` (for Better Auth lookups). */
export const headersRequest = (request: HttpServerRequest, origin: string): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(new URL(request.url, origin).toString(), { method: "GET", headers });
};
