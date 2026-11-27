import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { runMobileEffect } from "../runtime/request-intent";

/**
 * Raw access to Better Auth under `/api/auth` (ui-port-contracts 5.1). The typed `/api/v1`
 * client never covers these routes. Android sends the bearer and picks up a rotated token from
 * `set-auth-token` (Better Auth `bearer` plugin); the PWA sends its cookie.
 */
export interface AuthResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  /** A new session token the server issued (sign in, verify link, passkey). */
  readonly token: string | null;
}

export interface AuthRequest {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export type AuthFetch = (path: string, request?: AuthRequest) => Promise<AuthResponse>;

class AuthTransportError extends Schema.TaggedError<
  AuthTransportError,
  { readonly brand: unique symbol }
>()("AuthTransportError", {
  cause: Schema.Unknown,
}) {}

const authJson = Schema.fromJsonString(Schema.Unknown);

export const makeAuthFetch: {
  (token: () => string | null, fetchImpl?: FetchLike): (origin: string) => AuthFetch;
  (origin: string, token: () => string | null, fetchImpl?: FetchLike): AuthFetch;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (origin: string, token: () => string | null, fetchImpl?: FetchLike): AuthFetch => {
    const requestAuth = Effect.fn("MobileAuth.request")(function* (
      path: string,
      request: AuthRequest = {},
    ) {
      const url = yield* Effect.try({
        try: () => new URL(`/api/auth${path}`, origin),
        catch: (cause) => AuthTransportError.make({ cause }),
      });
      for (const [key, value] of Rec.toEntries(request.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers = new Headers({ accept: "application/json", ...request.headers });
      const bearer = token();
      if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
      const body =
        request.body === undefined ? undefined : yield* Schema.encodeEffect(authJson)(request.body);
      if (body !== undefined) headers.set("content-type", "application/json");
      const fetch = fetchImpl ?? (yield* FetchHttpClient.Fetch);
      const response = yield* Effect.tryPromise({
        try: (signal) => {
          const init = {
            method: request.method ?? (request.body === undefined ? "GET" : "POST"),
            headers,
            credentials: "include",
            signal,
          } satisfies RequestInit;
          return fetch(url, body === undefined ? init : { ...init, body });
        },
        catch: (cause) => AuthTransportError.make({ cause }),
      });
      const raw = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => AuthTransportError.make({ cause }),
      });
      return {
        status: response.status,
        ok: response.ok,
        body: raw === "" ? null : Option.getOrElse(Schema.decodeOption(authJson)(raw), () => raw),
        token: response.headers.get("set-auth-token"),
      };
    });
    return (path, request) => runMobileEffect(requestAuth(path, request));
  },
);
