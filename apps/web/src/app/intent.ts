/**
 * What a page asks the Shell to do (its OutMessage): navigate, toast, change viewer preferences,
 * reload the session after sign-in/out or a workspace change.
 */
import { Schema } from "effect";
import { Prefs } from "./prefs";

export const PendingNavigation = Schema.Union([
  Schema.TaggedStruct("Path", { path: Schema.String, replace: Schema.Boolean }),
  Schema.TaggedStruct("DefaultSignedIn", {}),
]);
export type PendingNavigation = typeof PendingNavigation.Type;

export const Intent = Schema.Union([
  Schema.TaggedStruct("Navigate", { path: Schema.String, replace: Schema.Boolean }),
  Schema.TaggedStruct("Toast", { text: Schema.String, tone: Schema.Literals(["info", "error"]) }),
  Schema.TaggedStruct("SetPrefs", { prefs: Prefs }),
  Schema.TaggedStruct("ReloadSession", {
    then: Schema.optionalKey(PendingNavigation),
  }),
  Schema.TaggedStruct("SignedOut", {}),
]);
export type Intent = typeof Intent.Type;

export const Intent_ = {
  navigate: (path: string, replace = false): Intent => ({ _tag: "Navigate", path, replace }),
  toast: (text: string, tone: "info" | "error" = "info"): Intent => ({ _tag: "Toast", text, tone }),
  setPrefs: (prefs: Prefs): Intent => ({ _tag: "SetPrefs", prefs }),
  reloadSession: (then?: PendingNavigation): Intent =>
    then === undefined ? { _tag: "ReloadSession" } : { _tag: "ReloadSession", then },
  signedOut: (): Intent => ({ _tag: "SignedOut" }),
} as const;
