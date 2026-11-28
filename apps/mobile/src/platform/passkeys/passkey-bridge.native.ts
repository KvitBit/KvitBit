/**
 * Native PasskeyBridge over `react-native-passkeys` (Android Credential Manager / iOS Passkeys).
 * Adapted from DeskoHub's native-passkey-module.service.ts and passkey-credential.ts.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { PlatformOperationFailed, tryPlatform } from "../platform-effect";
import type {
  JsonObject,
  PasskeyAvailability,
  PasskeyBridge,
  PasskeyOutcome,
} from "./passkey-bridge";
import {
  classifyNativePasskeyError,
  NativeFields,
  normalizeAuthenticationResponse,
  normalizeRegistrationResponse,
} from "./passkey-codec";
import { decodeCreationOptions, decodeRequestOptions } from "./passkey-options";

const decodeNativeResponse = Schema.decodeUnknownOption(NativeFields);

export interface NativePasskeyModule {
  readonly isSupported: () => boolean;
  readonly create: (request: JsonObject) => Promise<unknown>;
  readonly get: (request: JsonObject) => Promise<unknown>;
}

const loadNativeModule = (): Promise<NativePasskeyModule | null> =>
  runMobileEffect(
    fromMobilePromise(() => import("react-native-passkeys")).pipe(
      Effect.map(({ isSupported, create, get }) => ({
        isSupported,
        create: (options: JsonObject) =>
          runMobileEffect(
            decodeCreationOptions(options).pipe(
              Effect.flatMap((decoded) =>
                fromMobilePromise(() => create({ ...options, ...decoded })).pipe(
                  Effect.mapError(({ cause }) => PlatformOperationFailed.make({ cause })),
                ),
              ),
            ),
          ),
        get: (options: JsonObject) =>
          runMobileEffect(
            decodeRequestOptions(options).pipe(
              Effect.flatMap((decoded) =>
                fromMobilePromise(() => get({ ...options, ...decoded })).pipe(
                  Effect.mapError(({ cause }) => PlatformOperationFailed.make({ cause })),
                ),
              ),
            ),
          ),
      })),
      Effect.orElseSucceed(() => null),
    ),
  );

const isPlatformFailure = Schema.is(PlatformOperationFailed);

const failed = (cause: unknown): PasskeyOutcome<JsonObject> => {
  const nativeCause = isPlatformFailure(cause) ? cause.cause : cause;
  const classified = classifyNativePasskeyError(nativeCause);
  return classified.kind === "cancelled"
    ? { _tag: "Cancelled" }
    : { _tag: "Failed", message: classified.message };
};

export const makeNativePasskeyBridge = (
  load: () => Promise<NativePasskeyModule | null> = loadNativeModule,
): PasskeyBridge => {
  const module = fromMobilePromise(load);
  const availability = Effect.fn("NativePasskeys.availability")(function* () {
    const native = yield* module;
    if (native === null) return "unavailable" as const;
    return (yield* tryPlatform(() => native.isSupported()))
      ? ("available" as const)
      : ("unavailable" as const);
  });

  const prompt = Effect.fn("NativePasskeys.prompt")(function* (
    method: "create" | "get",
    options: JsonObject,
  ): Effect.fn.Return<PasskeyOutcome<JsonObject>, never> {
    const native = yield* module.pipe(Effect.orElseSucceed(() => null));
    if (native === null) return { _tag: "Failed", message: "passkeys unavailable" };
    return yield* fromMobilePromise(() => native[method](options)).pipe(
      Effect.map((raw): PasskeyOutcome<JsonObject> => {
        if (raw === null || raw === undefined) return { _tag: "Cancelled" };
        const normalize =
          method === "create" ? normalizeRegistrationResponse : normalizeAuthenticationResponse;
        const decoded = decodeNativeResponse(raw);
        const normalized = Option.isSome(decoded) ? normalize(decoded.value) : null;
        if (normalized !== null) return { _tag: "Ok", value: normalized };
        return {
          _tag: "Failed",
          message:
            method === "create"
              ? "invalid registration response"
              : "invalid authentication response",
        };
      }),
      Effect.catch((error) => Effect.succeed(failed(error.cause))),
    );
  });

  return {
    availability: () =>
      runMobileEffect(
        availability().pipe(Effect.orElseSucceed((): PasskeyAvailability => "unavailable")),
      ),
    create: (options) => runMobileEffect(prompt("create", options)),
    get: (options) => runMobileEffect(prompt("get", options)),
  };
};

export const passkeyBridge: PasskeyBridge = makeNativePasskeyBridge();
