/**
 * PasskeyBridge (ui-port-contracts 5.2): Android Credential Manager through react-native-passkeys
 * (passkey-bridge.native.ts), `navigator.credentials` on web (passkey-bridge.web.ts). Options and
 * responses are the WebAuthn Level 3 JSON forms Better Auth's passkey plugin sends and expects.
 */
import * as Effect from "effect/Effect";
import { runMobileEffect } from "../../runtime/request-intent";

export type JsonObject = typeof import("./passkey-codec").JsonObject.Type;

export type PasskeyAvailability = "available" | "unavailable" | "hybrid_only";

export type PasskeyOutcome<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  /** User dismissed the sheet or no credential was chosen: no error banner. */
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Failed"; readonly message: string };

export interface PasskeyBridge {
  readonly availability: () => Promise<PasskeyAvailability>;
  /** PublicKeyCredentialCreationOptionsJSON -> RegistrationResponseJSON */
  readonly create: (options: JsonObject) => Promise<PasskeyOutcome<JsonObject>>;
  /** PublicKeyCredentialRequestOptionsJSON -> AuthenticationResponseJSON */
  readonly get: (options: JsonObject) => Promise<PasskeyOutcome<JsonObject>>;
}

/** Platform default; replaced by the .native / .web variants. */
export const passkeyBridge: PasskeyBridge = {
  availability: () => runMobileEffect(Effect.succeed("unavailable")),
  create: () =>
    runMobileEffect(Effect.succeed({ _tag: "Failed", message: "passkeys unavailable" })),
  get: () => runMobileEffect(Effect.succeed({ _tag: "Failed", message: "passkeys unavailable" })),
};
