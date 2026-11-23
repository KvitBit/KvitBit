/**
 * Running KvitbitApi calls as data (ui-port-contracts section 2.3): every call ends in an
 * `ApiResult`, never a failure, so `update` handles errors as ordinary Messages.
 */
import { type Duration, Effect } from "effect";
import { KvitbitApi, type KvitbitApiClient } from "./client";
import { fromCause, type UiError } from "./errors";

export type ApiResult<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Err"; readonly error: UiError };

export const ok = <A>(value: A): ApiResult<A> => ({ _tag: "Ok", value });
export const err = <A = never>(error: UiError): ApiResult<A> => ({ _tag: "Err", error });

export const DEFAULT_TIMEOUT: Duration.Input = "20 seconds";

export interface CallOptions {
  /** Request key: a newer command with the same key supersedes the older one (T3). */
  readonly key?: string;
  readonly timeout?: Duration.Input;
}

/** Any effect to an ApiResult: timeout, typed errors, transport failures and interruption. */
export const attempt = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly timeout?: Duration.Input },
): Effect.Effect<ApiResult<A>, never, R> =>
  effect.pipe(
    Effect.timeout(options?.timeout ?? DEFAULT_TIMEOUT),
    Effect.matchCause({
      onSuccess: (value) => ok(value),
      onFailure: (cause) => err<A>(fromCause(cause)),
    }),
  );

export interface ApiCommand<Msg> {
  readonly name: string;
  readonly key: string | undefined;
  readonly effect: Effect.Effect<Msg, never, KvitbitApi>;
}

/** The one way a presenter talks to the server. */
export const call = <A, E, Msg>(
  name: string,
  run: (api: KvitbitApiClient) => Effect.Effect<A, E>,
  toMsg: (result: ApiResult<A>) => Msg,
  options?: CallOptions,
): ApiCommand<Msg> => ({
  name,
  key: options?.key,
  effect: attempt(
    Effect.gen(function* () {
      return yield* run(yield* KvitbitApi);
    }),
    options,
  ).pipe(Effect.map(toMsg)),
});

export const matchResult = <A, B>(
  result: ApiResult<A>,
  cases: { readonly onOk: (value: A) => B; readonly onErr: (error: UiError) => B },
): B => (result._tag === "Ok" ? cases.onOk(result.value) : cases.onErr(result.error));
