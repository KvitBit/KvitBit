/**
 * Private helpers shared across the `public` page group.
 * Never imported outside src/page/public/.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Client, type Failure, request, type WebServices } from "../../app/api";
import { writeClipboard } from "../../app/browser";
import type { Translator } from "../../app/i18n";
import type { BadgeTone } from "../../ui/kit";

/** Typed wrapper over `app/api.ts#request` allowing distinct success and failure Message types. */
const callApiImpl = <A, E, M1, M2>(
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M1,
  onFailure: (f: Failure) => M2,
): Effect.Effect<M1 | M2, never, WebServices> => request<A, E, M1 | M2>(call, onSuccess, onFailure);

export const callApi: {
  <A, E, M1, M2>(
    onSuccess: (a: A) => M1,
    onFailure: (f: Failure) => M2,
  ): (call: (client: Client) => Effect.Effect<A, E>) => Effect.Effect<M1 | M2, never, WebServices>;
  <A, E, M1, M2>(
    call: (client: Client) => Effect.Effect<A, E>,
    onSuccess: (a: A) => M1,
    onFailure: (f: Failure) => M2,
  ): Effect.Effect<M1 | M2, never, WebServices>;
} = Fn.dual(3, callApiImpl);

/** Renders a `Failure` to a plain user-facing message via the ui-port catalog. */
const failureMessageImpl = (t: Translator, failure: Failure): string =>
  failure.text.params === undefined
    ? t.translate({ key: failure.text.key })
    : t.translate({ key: failure.text.key, params: failure.text.params });

export const failureMessage: {
  (failure: Failure): (t: Translator) => string;
  (t: Translator, failure: Failure): string;
} = Fn.dual(2, failureMessageImpl);

/** Finds the first field-level issue matching `path` on a `Failure`. */
const fieldIssueImpl = (
  t: Translator,
  failure: Failure | null,
  path: string,
): string | undefined => {
  if (failure === null) return undefined;
  const hit = Option.getOrUndefined(Arr.findFirst(failure.issues, (i) => i.path === path));
  if (hit === undefined) return undefined;
  return t.translate(hit.text);
};

export const fieldIssue: {
  (failure: Failure | null, path: string): (t: Translator) => string | undefined;
  (t: Translator, failure: Failure | null, path: string): string | undefined;
} = Fn.dual(3, fieldIssueImpl);

/** Browser clipboard copy wrapped in a never-failing Effect for Effect UI Commands. */
const copyToClipboardImpl = <M>(value: string, onDone: (ok: boolean) => M): Effect.Effect<M> =>
  writeClipboard(value).pipe(Effect.map(onDone));

export const copyToClipboard: {
  <M>(onDone: (ok: boolean) => M): (value: string) => Effect.Effect<M>;
  <M>(value: string, onDone: (ok: boolean) => M): Effect.Effect<M>;
} = Fn.dual(2, copyToClipboardImpl);

/** Browser hard redirect (used after OAuth consent decision returns an external `redirectTo`). */
const redirectLocationImpl = <M>(url: string, onDone: () => M): Effect.Effect<M> =>
  Effect.sync(() => {
    globalThis.location?.assign(url);
    return onDone();
  });

export const redirectLocation: {
  <M>(onDone: () => M): (url: string) => Effect.Effect<M>;
  <M>(url: string, onDone: () => M): Effect.Effect<M>;
} = Fn.dual(2, redirectLocationImpl);

/** Maps a document settlement state to a kit badge tone. */
export const settlementTone = (settlement: string): BadgeTone => {
  switch (settlement) {
    case "paid":
      return "paid";
    case "overpaid":
      return "paid";
    case "partially_paid":
      return "proforma";
    case "credited":
      return "draft";
    default:
      return "neutral";
  }
};

/** Maps a document status to a kit badge tone. */
export const statusTone = (status: string): BadgeTone => {
  switch (status) {
    case "cancelled":
      return "error";
    case "draft":
      return "draft";
    default:
      return "neutral";
  }
};

/** Formats byte counts for human display (e.g. APK size). */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Decoders for the opaque snapshot types carried inside `SharedDocumentView`. */
const NullableText = Schema.NullOr(Schema.String);

export const ParsedAddress = Schema.Struct({
  street: Schema.optionalKey(NullableText),
  city: Schema.optionalKey(NullableText),
  postalCode: Schema.optionalKey(NullableText),
  country: Schema.optionalKey(Schema.String),
});
export type ParsedAddress = typeof ParsedAddress.Type;

const ParsedBankAccount = Schema.Struct({
  name: Schema.optionalKey(NullableText),
  currency: Schema.optionalKey(Schema.String),
  accountNumber: Schema.optionalKey(NullableText),
  iban: Schema.optionalKey(NullableText),
  bic: Schema.optionalKey(NullableText),
});

const ParsedIssuer = Schema.Struct({
  name: Schema.String,
  ico: Schema.optionalKey(NullableText),
  dic: Schema.optionalKey(NullableText),
  address: Schema.optionalKey(ParsedAddress),
  registerEntry: Schema.optionalKey(NullableText),
  email: Schema.optionalKey(NullableText),
  phone: Schema.optionalKey(NullableText),
  web: Schema.optionalKey(NullableText),
  regime: Schema.optionalKey(Schema.String),
  bankAccount: ParsedBankAccount.pipe(Schema.NullOr, Schema.optionalKey),
});

const ParsedContact = Schema.Struct({
  name: Schema.String,
  ico: Schema.optionalKey(NullableText),
  dic: Schema.optionalKey(NullableText),
  address: Schema.optionalKey(ParsedAddress),
});

const ParsedLine = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  description: Schema.String,
  quantity: Schema.Union([Schema.String, Schema.Finite]),
  unit: Schema.optionalKey(NullableText),
  unitPrice: Schema.Union([Schema.String, Schema.Finite]),
  ratePercent: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  amount: Schema.Union([Schema.String, Schema.Finite]),
  treatment: Schema.optionalKey(Schema.String),
});

const decodeIssuer = Schema.decodeUnknownOption(ParsedIssuer);
const decodeContact = Schema.decodeUnknownOption(ParsedContact);
const decodeLine = Schema.decodeUnknownOption(ParsedLine);

export const parseIssuer = Fn.flow(decodeIssuer, Option.getOrUndefined);
export const parseContact = Fn.flow(decodeContact, Option.getOrUndefined);
export const parseLine = Fn.flow(decodeLine, Option.getOrUndefined);

/** Formats a postal address into a single readable line. */
export const formatAddressLine = (address: ParsedAddress | undefined): string => {
  if (address === undefined) return "";
  const parts = Arr.filter(
    [
      address.street ?? "",
      Arr.join(Arr.filter([address.postalCode ?? "", address.city ?? ""], Boolean), " "),
      address.country ?? "",
    ],
    Boolean,
  );
  return Arr.join(parts, ", ");
};

/** Derives a URL-safe workspace slug from a business name. */
export const slugifyName = (name: string): string =>
  Str.slice(
    0,
    48,
  )(
    Str.replace(
      /^-+|-+$/g,
      "",
    )(
      Str.replace(
        /[^a-z0-9]+/g,
        "-",
      )(Str.toLowerCase(Str.replace(/[\u0300-\u036f]/g, "")(Str.normalize("NFD")(name)))),
    ),
  );
