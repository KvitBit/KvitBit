/**
 * Running KvitbitApi calls as data (ui-port-contracts section 2.3): every call ends in an
 * `ApiResult`, never a failure, so `update` handles errors as ordinary Messages.
 */
import { type Duration, Effect } from "effect";
import {
  KvitbitApi,
  type KvitbitApiClient,
  type ObservedResponse,
  ResponseObserver,
} from "./client";
import { fromCause, UiError } from "./errors";

const cancelledError: UiError = UiError.cancelled;

export interface ResponseMeta {
  /** Parsed from `ETag: "<revision>"`. */
  readonly etag: number | null;
  /** `Idempotent-Replayed: true`. */
  readonly replayed: boolean;
}

export const noMeta: ResponseMeta = { etag: null, replayed: false };

export type ApiResult<A> =
  | { readonly _tag: "Ok"; readonly value: A; readonly meta: ResponseMeta }
  | { readonly _tag: "Err"; readonly error: UiError };

export const ok = <A>(value: A, meta: ResponseMeta = noMeta): ApiResult<A> => ({
  _tag: "Ok",
  value,
  meta,
});
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
  Effect.suspend(() => {
    const observed: { current: ObservedResponse | null } = { current: null };
    return effect.pipe(
      Effect.timeout(options?.timeout ?? DEFAULT_TIMEOUT),
      Effect.provideService(ResponseObserver, observed),
      Effect.matchCause({
        onSuccess: (value) =>
          ok(
            value,
            observed.current === null
              ? noMeta
              : { etag: observed.current.etag, replayed: observed.current.replayed },
          ),
        onFailure: (cause) => err<A>(withResponse(fromCause(cause), observed.current)),
      }),
    );
  });

/** A body that failed to decode still had a status and request id: keep them for support. */
const withResponse = (error: UiError, response: ObservedResponse | null): UiError =>
  error._tag === "Unexpected" && error.status === null && response !== null
    ? { ...error, status: response.status, requestId: error.requestId ?? response.requestId }
    : error;

export interface ApiCommand<Msg> {
  readonly name: string;
  readonly key?: string;
  readonly effect: Effect.Effect<Msg, never, KvitbitApi>;
  /**
   * The Message for this command when the runner interrupts it (superseded by key, screen left):
   * an interrupted fiber cannot return a value, so the runner dispatches this instead (T2).
   */
  readonly cancelled: Msg;
}

/** The one way a presenter talks to the server. */
export const call = <A, E, Msg>(
  name: string,
  run: (api: KvitbitApiClient) => Effect.Effect<A, E>,
  toMsg: (result: ApiResult<A>) => Msg,
  options?: CallOptions,
): ApiCommand<Msg> => {
  const command = {
    name,
    effect: attempt(
      Effect.gen(function* () {
        return yield* run(yield* KvitbitApi);
      }),
      options,
    ).pipe(Effect.map(toMsg)),
    cancelled: toMsg(err(cancelledError)),
  };
  return options?.key === undefined ? command : { ...command, key: options.key };
};

export const matchResult = <A, B>(
  result: ApiResult<A>,
  cases: { readonly onOk: (value: A) => B; readonly onErr: (error: UiError) => B },
): B => (result._tag === "Ok" ? cases.onOk(result.value) : cases.onErr(result.error));
