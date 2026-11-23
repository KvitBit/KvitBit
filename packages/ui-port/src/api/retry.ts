/**
 * Retry and connectivity state. Pure helpers for TEA models (a backoff delay per attempt, a
 * control disabled until `Retry-After`, online/offline from what requests observe) plus one
 * Effect-level retry for retryable failures, which keeps the same Idempotency-Key by construction
 * because it re-runs the same request.
 */
import { Duration, Effect, Random } from "effect";
import { isRetryable, retryAfterSeconds, toUiError, type UiError } from "./errors";

export interface Backoff {
  readonly baseMillis: number;
  readonly factor: number;
  readonly maxMillis: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: Backoff = {
  baseMillis: 1_000,
  factor: 2,
  maxMillis: 30_000,
  maxAttempts: 5,
};

/**
 * Delay before retry number `attempt` (1-based), or null when no retry should follow. `Retry-After`
 * (RateLimited, Unavailable) wins over the exponential delay. `jitter` in [0, 1) spreads clients
 * between half and the full delay.
 */
export const retryDelayMillis = (
  error: UiError,
  attempt: number,
  jitter = 1,
  backoff: Backoff = DEFAULT_BACKOFF,
): number | null => {
  if (!isRetryable(error) || attempt > backoff.maxAttempts) return null;
  const after = retryAfterSeconds(error);
  if (after !== null) return after * 1_000;
  const exponential = Math.min(
    backoff.maxMillis,
    backoff.baseMillis * backoff.factor ** (attempt - 1),
  );
  return Math.round(exponential * (0.5 + 0.5 * Math.min(1, Math.max(0, jitter))));
};

/** Retry state of one control or queued job. */
export interface RetryState {
  readonly attempt: number;
  /** Epoch millis before which Retry stays disabled; null when retry is allowed now. */
  readonly notBefore: number | null;
  readonly exhausted: boolean;
}

const idle: RetryState = { attempt: 0, notBefore: null, exhausted: false };

const afterFailure = (
  state: RetryState,
  error: UiError,
  now: number,
  jitter = 1,
  backoff: Backoff = DEFAULT_BACKOFF,
): RetryState => {
  const attempt = state.attempt + 1;
  const delay = retryDelayMillis(error, attempt, jitter, backoff);
  return delay === null
    ? { attempt, notBefore: null, exhausted: true }
    : { attempt, notBefore: now + delay, exhausted: false };
};

const canRetry = (state: RetryState, now: number): boolean =>
  !state.exhausted && (state.notBefore === null || now >= state.notBefore);

/** Seconds left on a disabled control, for the countdown text. */
const secondsLeft = (state: RetryState, now: number): number =>
  state.notBefore === null ? 0 : Math.max(0, Math.ceil((state.notBefore - now) / 1_000));

/**
 * Retries retryable failures with the same delays as `retryDelayMillis` (Retry-After first, else
 * jittered exponential backoff); the last failure propagates.
 */
export const retryTransient = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  backoff: Backoff = DEFAULT_BACKOFF,
): Effect.Effect<A, E, R> => {
  const loop = (attempt: number): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catch((error: E) =>
        Effect.flatMap(Random.next, (jitter) => {
          const delay = retryDelayMillis(toUiError(error), attempt, jitter, backoff);
          return delay === null
            ? Effect.fail(error)
            : Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(loop(attempt + 1)));
        }),
      ),
    );
  return loop(1);
};

// --- connectivity -------------------------------------------------------------------------------

export type Connectivity =
  | { readonly _tag: "Online" }
  | { readonly _tag: "Offline"; readonly since: number };

const online: Connectivity = { _tag: "Online" };

/** Platform signal (navigator.onLine events, NetInfo). */
const fromPlatform = (state: Connectivity, isOnline: boolean, now: number): Connectivity =>
  isOnline ? online : state._tag === "Offline" ? state : { _tag: "Offline", since: now };

/**
 * What a finished request says: `Offline` means no response arrived; any response (success or a
 * wire error) proves the server is reachable. Timeouts and cancellations say nothing.
 */
const observe = (
  state: Connectivity,
  outcome: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
  now: number,
): Connectivity => {
  if (outcome._tag === "Ok") return online;
  switch (outcome.error._tag) {
    case "Offline":
      return state._tag === "Offline" ? state : { _tag: "Offline", since: now };
    case "Timeout":
    case "Cancelled":
      return state;
    default:
      return online;
  }
};

export const RetryState = { idle, afterFailure, canRetry, secondsLeft } as const;

export const Connectivity = { online, fromPlatform, observe } as const;
