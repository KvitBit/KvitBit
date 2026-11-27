import type { RegistryResult } from "@kvitbit/domain/contract";
import type { UiError } from "@kvitbit/ui-port/api";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { IssuingEntityData } from "./workspace-data";

/**
 * Pure ARES lookup state machine (adapted from deskohub-mobile's company-lookup-model):
 * registry results wait for user review with a field diff before applying, and editing IČO
 * resets any stale lookup or in-flight result.
 */
export interface AresFieldDiff {
  readonly field:
    | "name"
    | "dic"
    | "street"
    | "city"
    | "postalCode"
    | "country"
    | "legalForm"
    | "registerEntry";
  readonly before: string;
  readonly after: string;
}

export type AresLookupState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "LookingUp"; readonly ico: string }
  | {
      readonly _tag: "Found";
      readonly ico: string;
      readonly result: RegistryResult;
      readonly diffs: ReadonlyArray<AresFieldDiff>;
    }
  | { readonly _tag: "Applied"; readonly ico: string }
  | { readonly _tag: "Failed"; readonly ico: string; readonly error: UiError };

export const aresIdle: AresLookupState = { _tag: "Idle" };

export const aresStarted = (typedIco: string): AresLookupState => {
  const ico = Str.trim(typedIco);
  if (ico === "") return aresIdle;
  return { _tag: "LookingUp", ico };
};

export const computeAresDiffs: {
  (registry: RegistryResult): (current: IssuingEntityData) => ReadonlyArray<AresFieldDiff>;
  (current: IssuingEntityData, registry: RegistryResult): ReadonlyArray<AresFieldDiff>;
} = Fn.dual(
  2,
  (current: IssuingEntityData, registry: RegistryResult): ReadonlyArray<AresFieldDiff> => {
    const pairs: ReadonlyArray<readonly [AresFieldDiff["field"], string, string | null]> = [
      ["name", current.name, registry.name],
      ["dic", current.dic ?? "", registry.dic],
      ["street", current.address.street, registry.address.street],
      ["city", current.address.city, registry.address.city],
      ["postalCode", current.address.postalCode, registry.address.postalCode],
      ["country", current.address.country, registry.address.country],
      ["legalForm", current.legalForm ?? "", registry.legalForm],
      ["registerEntry", current.registerEntry ?? "", registry.registerEntry],
    ];
    const diffs: AresFieldDiff[] = [];
    for (const [field, before, rawAfter] of pairs) {
      if (rawAfter === null) continue;
      const after = Str.trim(rawAfter);
      if (after !== "" && after !== Str.trim(before)) {
        diffs.push({ field, before: Str.trim(before), after });
      }
    }
    return diffs;
  },
);

export const aresSettled: {
  (
    current: IssuingEntityData,
    outcome:
      | { readonly _tag: "Ok"; readonly value: RegistryResult }
      | { readonly _tag: "Err"; readonly error: UiError },
  ): (ico: string) => AresLookupState;
  (
    ico: string,
    current: IssuingEntityData,
    outcome:
      | { readonly _tag: "Ok"; readonly value: RegistryResult }
      | { readonly _tag: "Err"; readonly error: UiError },
  ): AresLookupState;
} = Fn.dual(
  3,
  (
    ico: string,
    current: IssuingEntityData,
    outcome:
      | { readonly _tag: "Ok"; readonly value: RegistryResult }
      | { readonly _tag: "Err"; readonly error: UiError },
  ): AresLookupState =>
    outcome._tag === "Ok"
      ? {
          _tag: "Found",
          ico,
          result: outcome.value,
          diffs: computeAresDiffs(current, outcome.value),
        }
      : { _tag: "Failed", ico, error: outcome.error },
);

export const aresAfterIcoEdit: {
  (typedIco: string): (state: AresLookupState) => AresLookupState;
  (state: AresLookupState, typedIco: string): AresLookupState;
} = Fn.dual(
  2,
  (state: AresLookupState, typedIco: string): AresLookupState =>
    state._tag === "Idle" || state.ico === Str.trim(typedIco) ? state : aresIdle,
);

/** Merges non-empty ARES values into the issuing entity draft without clearing missing fields. */
export const applyAresResult: {
  (registry: RegistryResult): (current: IssuingEntityData) => IssuingEntityData;
  (current: IssuingEntityData, registry: RegistryResult): IssuingEntityData;
} = Fn.dual(
  2,
  (current: IssuingEntityData, registry: RegistryResult): IssuingEntityData => ({
    ...current,
    ico: registry.ico || current.ico,
    name: registry.name || current.name,
    dic: registry.dic ?? current.dic,
    legalForm: registry.legalForm || current.legalForm,
    registerEntry: registry.registerEntry ?? current.registerEntry,
    address: {
      street: registry.address.street || current.address.street,
      city: registry.address.city || current.address.city,
      postalCode: registry.address.postalCode || current.address.postalCode,
      country: registry.address.country || current.address.country,
    },
  }),
);
