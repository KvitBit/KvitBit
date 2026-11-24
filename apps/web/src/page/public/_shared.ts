/**
 * Private helpers shared across the `public` page group.
 * Never imported outside src/page/public/.
 */
import { Effect, Schema } from "effect";
import { type Client, type Failure, request, type WebServices } from "../../app/api";
import type { Translator } from "../../app/i18n";
import type { BadgeTone } from "../../ui/kit";

/** Typed wrapper over `app/api.ts#request` allowing distinct success and failure Message types. */
export const callApi = <A, E, M1, M2>(
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M1,
  onFailure: (f: Failure) => M2,
): Effect.Effect<M1 | M2, never, WebServices> => request<A, E, M1 | M2>(call, onSuccess, onFailure);

/** Renders a `Failure` to a plain user-facing message via the ui-port catalog. */
export const failureMessage = (t: Translator, failure: Failure): string =>
  t.translate({
    key: failure.text.key,
    ...(failure.text.params === undefined ? {} : { params: failure.text.params }),
  });

/** Finds the first field-level issue matching `path` on a `Failure`. */
export const fieldIssue = (
  t: Translator,
  failure: Failure | null,
  path: string,
): string | undefined => {
  if (failure === null) return undefined;
  const hit = failure.issues.find((i) => i.path === path);
  if (hit === undefined) return undefined;
  return t.translate({
    key: hit.text.key,
    ...(hit.text.params === undefined ? {} : { params: hit.text.params }),
  });
};

/** Browser clipboard copy wrapped in a never-failing Effect for Foldkit Commands. */
export const copyToClipboard = <M>(value: string, onDone: (ok: boolean) => M): Effect.Effect<M> =>
  Effect.tryPromise({
    try: async () => {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(value);
        return true;
      }
      return false;
    },
    catch: () => false,
  }).pipe(
    Effect.map((ok) => onDone(ok)),
    Effect.catch(() => Effect.succeed(onDone(false))),
  );

/** Browser hard redirect (used after OAuth consent decision returns an external `redirectTo`). */
export const redirectLocation = <M>(url: string, onDone: () => M): Effect.Effect<M> =>
  Effect.sync(() => {
    if (typeof location !== "undefined" && typeof location.assign === "function") {
      location.assign(url);
    }
    return onDone();
  });

/** Returns a safe relative internal path for post-auth redirects, rejecting open redirects. */
export const safeReturnTo = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) return undefined;
  return raw;
};

/** Generates an idempotency key inside a Command (pure fallback when crypto is unavailable). */
export const randomKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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

export const ParsedBankAccount = Schema.Struct({
  name: Schema.optionalKey(NullableText),
  currency: Schema.optionalKey(Schema.String),
  accountNumber: Schema.optionalKey(NullableText),
  iban: Schema.optionalKey(NullableText),
  bic: Schema.optionalKey(NullableText),
});
export type ParsedBankAccount = typeof ParsedBankAccount.Type;

export const ParsedIssuer = Schema.Struct({
  name: Schema.String,
  ico: Schema.optionalKey(NullableText),
  dic: Schema.optionalKey(NullableText),
  address: Schema.optionalKey(ParsedAddress),
  registerEntry: Schema.optionalKey(NullableText),
  email: Schema.optionalKey(NullableText),
  phone: Schema.optionalKey(NullableText),
  web: Schema.optionalKey(NullableText),
  regime: Schema.optionalKey(Schema.String),
  bankAccount: Schema.optionalKey(Schema.NullOr(ParsedBankAccount)),
});
export type ParsedIssuer = typeof ParsedIssuer.Type;

export const ParsedContact = Schema.Struct({
  name: Schema.String,
  ico: Schema.optionalKey(NullableText),
  dic: Schema.optionalKey(NullableText),
  address: Schema.optionalKey(ParsedAddress),
});
export type ParsedContact = typeof ParsedContact.Type;

export const ParsedLine = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  description: Schema.String,
  quantity: Schema.Union([Schema.String, Schema.Number]),
  unit: Schema.optionalKey(NullableText),
  unitPrice: Schema.Union([Schema.String, Schema.Number]),
  ratePercent: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  amount: Schema.Union([Schema.String, Schema.Number]),
  treatment: Schema.optionalKey(Schema.String),
});
export type ParsedLine = typeof ParsedLine.Type;

const decodeIssuer = Schema.decodeUnknownOption(ParsedIssuer);
const decodeContact = Schema.decodeUnknownOption(ParsedContact);
const decodeLine = Schema.decodeUnknownOption(ParsedLine);

export const parseIssuer = (raw: unknown): ParsedIssuer | undefined => {
  const opt = decodeIssuer(raw);
  return opt._tag === "Some" ? opt.value : undefined;
};

export const parseContact = (raw: unknown): ParsedContact | undefined => {
  const opt = decodeContact(raw);
  return opt._tag === "Some" ? opt.value : undefined;
};

export const parseLine = (raw: unknown): ParsedLine | undefined => {
  const opt = decodeLine(raw);
  return opt._tag === "Some" ? opt.value : undefined;
};

/** Formats a postal address into a single readable line. */
export const formatAddressLine = (address: ParsedAddress | undefined): string => {
  if (address === undefined) return "";
  const parts = [
    address.street ?? "",
    [address.postalCode ?? "", address.city ?? ""].filter(Boolean).join(" "),
    address.country ?? "",
  ].filter(Boolean);
  return parts.join(", ");
};

/** Derives a URL-safe workspace slug from a business name. */
export const slugifyName = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
