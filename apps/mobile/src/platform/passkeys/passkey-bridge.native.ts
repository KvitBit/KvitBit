/**
 * Native PasskeyBridge over `react-native-passkeys` (Android Credential Manager / iOS Passkeys).
 * Adapted from DeskoHub's native-passkey-module.service.ts and passkey-credential.ts.
 */
import type { JsonObject, PasskeyBridge, PasskeyOutcome } from "./passkey-bridge";
import {
  classifyNativePasskeyError,
  normalizeAuthenticationResponse,
  normalizeRegistrationResponse,
} from "./passkey-codec";

export interface NativePasskeyModule {
  readonly isSupported: () => boolean;
  readonly create: (request: JsonObject) => Promise<unknown>;
  readonly get: (request: JsonObject) => Promise<unknown>;
}

const loadNativeModule = async (): Promise<NativePasskeyModule | null> => {
  try {
    const mod = (await import("react-native-passkeys")) as unknown as Partial<NativePasskeyModule>;
    const { isSupported, create, get } = mod;
    if (
      typeof isSupported === "function" &&
      typeof create === "function" &&
      typeof get === "function"
    ) {
      return {
        isSupported: () => isSupported(),
        create: (req) => create(req),
        get: (req) => get(req),
      };
    }
    return null;
  } catch {
    return null;
  }
};

export const makeNativePasskeyBridge = (
  load: () => Promise<NativePasskeyModule | null> = loadNativeModule,
): PasskeyBridge => ({
  availability: async () => {
    const mod = await load();
    if (mod === null) return "unavailable";
    try {
      return mod.isSupported() ? "available" : "unavailable";
    } catch {
      return "unavailable";
    }
  },
  create: async (options): Promise<PasskeyOutcome<JsonObject>> => {
    const mod = await load();
    if (mod === null) return { _tag: "Failed", message: "passkeys unavailable" };
    try {
      const raw = await mod.create(options);
      if (raw === null || raw === undefined) return { _tag: "Cancelled" };
      const normalized = normalizeRegistrationResponse(raw);
      return normalized === null
        ? { _tag: "Failed", message: "invalid registration response" }
        : { _tag: "Ok", value: normalized };
    } catch (cause) {
      const classified = classifyNativePasskeyError(cause);
      return classified.kind === "cancelled"
        ? { _tag: "Cancelled" }
        : { _tag: "Failed", message: classified.message };
    }
  },
  get: async (options): Promise<PasskeyOutcome<JsonObject>> => {
    const mod = await load();
    if (mod === null) return { _tag: "Failed", message: "passkeys unavailable" };
    try {
      const raw = await mod.get(options);
      if (raw === null || raw === undefined) return { _tag: "Cancelled" };
      const normalized = normalizeAuthenticationResponse(raw);
      return normalized === null
        ? { _tag: "Failed", message: "invalid authentication response" }
        : { _tag: "Ok", value: normalized };
    } catch (cause) {
      const classified = classifyNativePasskeyError(cause);
      return classified.kind === "cancelled"
        ? { _tag: "Cancelled" }
        : { _tag: "Failed", message: classified.message };
    }
  },
});

export const passkeyBridge: PasskeyBridge = makeNativePasskeyBridge();
