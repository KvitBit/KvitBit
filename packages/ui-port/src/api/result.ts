/**
 * Running KvitbitApi calls as data (ui-port-contracts section 2.3): every call ends in an
 * `ApiResult`, never a failure, so `update` handles errors as ordinary Messages.
 */
import { type Duration, Effect, Exit, Fiber, type Scope } from "effect";
import {
  emptyResponseCell,
  KvitbitApi,
  type KvitbitApiClient,
  type ObservedResponse,
  ResponseObserver,
} from "./client";
import { fromCause, UiError } from "./errors";

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
    const observed = emptyResponseCell();
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
        onFailure: (cause) => err<A>(withResponse(fromCause(cause), observed.undecoded)),
      }),
    );
  });

/**
 * A body that failed to decode still had a status and request id: keep them for support. Only the
 * failing exchange counts; a failure before any request was sent keeps null.
 */
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
  /** The Message for a fiber that ended without a value for another reason (a defect). */
  readonly failed: (error: UiError) => Msg;
}

/**
 * The one Message a finished command fiber stands for: its value on success, `cancelled` when it
 * was interrupted (before or while running), else `failed` with the mapped error.
 */
export const messageFor = <Msg>(command: ApiCommand<Msg>, exit: Exit.Exit<Msg, never>): Msg => {
  if (Exit.isSuccess(exit)) return exit.value;
  const error = fromCause(exit.cause);
  return error._tag === "Cancelled" ? command.cancelled : command.failed(error);
};

/**
 * Runner side of a command (T2): forks it in the current scope and dispatches exactly one Message
 * from its actual Exit. Interrupting the returned fiber, or closing the scope, delivers
 * `cancelled`, even when the fiber had not started yet.
 */
export const runCommand = <Msg>(
  command: ApiCommand<Msg>,
  dispatch: (msg: Msg) => void,
): Effect.Effect<Fiber.Fiber<Msg>, never, KvitbitApi | Scope.Scope> =>
  // Fork and observer registration are one uninterruptible step: interrupting the runner between
  // them would leave a forked command nobody dispatches for. Only the command itself is restored
  // to interruptible, so superseding or closing the scope still cancels it.
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(restore(command.effect));
      // Detached and uninterruptible: the observer outlives the scope just long enough to see the
      // command's Exit, and it ends with it.
      yield* Effect.forkDetach(
        Effect.flatMap(Fiber.await(fiber), (exit) =>
          Effect.sync(() => dispatch(messageFor(command, exit))),
        ),
        { startImmediately: true, uninterruptible: true },
      );
      return fiber;
    }),
  );

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
    cancelled: toMsg(err(UiError.cancelled)),
    failed: (error: UiError) => toMsg(err(error)),
  };
  return options?.key === undefined ? command : { ...command, key: options.key };
};

export const matchResult = <A, B>(
  result: ApiResult<A>,
  cases: { readonly onOk: (value: A) => B; readonly onErr: (error: UiError) => B },
): B => (result._tag === "Ok" ? cases.onOk(result.value) : cases.onErr(result.error));
