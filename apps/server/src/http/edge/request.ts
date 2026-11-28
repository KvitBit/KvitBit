/** Request facts the edge derives from headers and the connection (sections 1, 2.4). */

import type { Locale } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type * as HttpServerError from "effect/http/HttpServerError";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Str from "effect/String";

/**
 * Client address: the entry `hops` places from the right of `X-Forwarded-For` (each trusted
 * proxy appends the address it saw), else the socket address. With `hops = 0` the header is
 * ignored.
 */
export const clientIp = Fn.dual<
  (hops: number) => (request: HttpServerRequest.HttpServerRequest) => string,
  (request: HttpServerRequest.HttpServerRequest, hops: number) => string
>(2, (request, hops) => {
  const forwarded = request.headers["x-forwarded-for"];
  if (hops > 0 && forwarded !== undefined) {
    const entries = Arr.filter(
      Arr.map(Str.split(forwarded, ","), Str.trim),
      (entry) => entry.length > 0,
    );
    const fromHop = Number.isInteger(hops) ? entries.at(-hops) : undefined;
    const address = fromHop ?? entries[0];
    if (address !== undefined) return address;
  }
  return Option.getOrElse(request.remoteAddress, () => "unknown");
});

const SUPPORTED: ReadonlyArray<Locale> = ["cs", "en"];

/**
 * First supported language of an `Accept-Language` header by quality (`cs` or `en`), else
 * undefined. Region subtags count for their language (`en-GB` is `en`).
 */
export const acceptLanguageLocale = (header: string | undefined): Locale | undefined => {
  if (header === undefined) return undefined;
  const ranked = Arr.filter(
    Arr.map(Str.split(header, ","), (part, index) => {
      const [tag = "", ...params] = Str.split(Str.trim(part), ";");
      const q = Arr.findFirst(Arr.map(params, Str.trim), Str.startsWith("q=")).pipe(
        Option.map(Str.slice(2)),
        Option.getOrUndefined,
      );
      const quality = q === undefined ? 1 : Number(q);
      return {
        language: Str.split(Str.toLowerCase(tag), "-")[0] ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    }),
    (entry) => entry.quality > 0,
  ).sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const entry of ranked) {
    const locale = Option.getOrUndefined(
      Arr.findFirst(SUPPORTED, (supported) => supported === entry.language),
    );
    if (locale !== undefined) return locale;
  }
  return undefined;
};

/** Principal locale rule (section 2.4): preference, else Accept-Language, else `cs`. */
export const resolveLocale = Fn.dual<
  (acceptLanguage: string | undefined) => (preference: Locale | null | undefined) => Locale,
  (preference: Locale | null | undefined, acceptLanguage: string | undefined) => Locale
>(2, (preference, acceptLanguage) => preference ?? acceptLanguageLocale(acceptLanguage) ?? "cs");

/** The bearer value of an `Authorization` header, if any. */
const BEARER = /^Bearer[ ]+(\S+)\s*$/i;
export const bearerToken = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined;
  const match = BEARER.exec(authorization);
  return match?.[1];
};

/** A body-less web `Request` carrying the headers of `request` (for Better Auth lookups). */
export const headersRequest = Fn.dual<
  (origin: string) => (request: HttpServerRequest.HttpServerRequest) => Request,
  (request: HttpServerRequest.HttpServerRequest, origin: string) => Request
>(2, (request, origin) => {
  const headers = new Headers();
  for (const [name, value] of EffectRecord.toEntries(request.headers)) {
    if (Predicate.isString(value)) headers.set(name, value);
  }
  return new Request(new URL(request.url, origin).toString(), { method: "GET", headers });
});

const requestParseReasons = { BodyTooLarge: true, Parse: false };

export const isRequestBodyTooLarge = ({ reason }: HttpServerError.HttpServerError): boolean =>
  reason._tag === "RequestParseError" &&
  reason.reason !== undefined &&
  requestParseReasons[reason.reason];
