/** Pure rules and validation helpers of the Workspaces module. */

import type {
  Conflict,
  IsoDate,
  Issue,
  IssueCode,
  NotFound,
  TaxRegime,
} from "@kvitbit/domain/contract";
import { Invalid, WorkspaceSlug } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { pragueDate } from "../../engines/calendar";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import type { TaxRegimePeriod } from "./model";

export const issue: {
  (
    code: IssueCode,
    params?: Record<string, string>,
  ): (path: ReadonlyArray<string | number>) => Issue;
  (path: ReadonlyArray<string | number>, code: IssueCode, params?: Record<string, string>): Issue;
} = Fn.dual(
  (args) => EffectArray.isArray(args[0]),
  (
    path: ReadonlyArray<string | number>,
    code: IssueCode,
    params?: Record<string, string>,
  ): Issue => ({ path: [...path], code, params }),
);

const invalidImpl = (path: ReadonlyArray<string | number>, code: IssueCode) =>
  Invalid.make({ issues: [issue(path, code)] });
export const invalid: {
  (code: IssueCode): (path: ReadonlyArray<string | number>) => ReturnType<typeof invalidImpl>;
  (path: ReadonlyArray<string | number>, code: IssueCode): ReturnType<typeof invalidImpl>;
} = Fn.dual(2, invalidImpl);

/** Fails with every collected issue, or succeeds when there are none. */
export const failIssues = (issues: ReadonlyArray<Issue>): Effect.Effect<void, Invalid> => {
  const [first, ...rest] = issues;
  return first === undefined
    ? Effect.void
    : Effect.fail(Invalid.make({ issues: [first, ...rest] }));
};

/** Decodes an open or opaque domain input with its concrete schema; failure is `request.malformed`. */
export const decodeInput: {
  <A>(
    value: Schema.Unknown["Type"],
    path?: ReadonlyArray<string | number>,
  ): (schema: Schema.Codec<A, unknown>) => Effect.Effect<A, Invalid>;
  <A>(
    schema: Schema.Codec<A, unknown>,
    value: Schema.Unknown["Type"],
    path?: ReadonlyArray<string | number>,
  ): Effect.Effect<A, Invalid>;
} = Fn.dual(
  (args) => Schema.isSchema(args[0]),
  <A>(
    schema: Schema.Codec<A, unknown>,
    value: Schema.Unknown["Type"],
    path: ReadonlyArray<string | number> = [],
  ): Effect.Effect<A, Invalid> =>
    Effect.mapError(Schema.decodeUnknownEffect(schema)(value), () =>
      invalid(path, "request.malformed"),
    ),
);

// Dates -------------------------------------------------------------------------------------

export { pragueDate } from "../../engines/calendar";

export const today: Effect.Effect<IsoDate> = Effect.map(Clock.currentTimeMillis, pragueDate);

export const nowIso: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso);

/** The Tax Regime in force on `date` (W2); periods are sorted and never empty. */
export const regimeOn: {
  (date: IsoDate): (periods: ReadonlyArray<TaxRegimePeriod>) => TaxRegime;
  (periods: ReadonlyArray<TaxRegimePeriod>, date: IsoDate): TaxRegime;
} = Fn.dual(2, (periods: ReadonlyArray<TaxRegimePeriod>, date: IsoDate): TaxRegime => {
  let regime = periods[0]?.regime ?? "non_vat_payer";
  for (const period of periods) if (period.effectiveFrom <= date) regime = period.regime;
  return regime;
});

// Slugs (W6) --------------------------------------------------------------------------------

export const isValidSlug = (slug: string): boolean => Schema.is(WorkspaceSlug)(slug);

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIC_FORMAT = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const DIACRITICS = /[̀-ͯ]/g;
const NON_SLUG_CHARACTERS = /[^a-z0-9]+/g;
const OUTER_HYPHENS = /^-+|-+$/g;
const TRAILING_HYPHENS = /-+$/g;

/** A slug candidate from a name: ASCII-folded, lowercase, hyphenated, 3 to 40 chars. */
export const slugify = (name: string): string => {
  const base = Fn.pipe(
    name,
    EffectString.normalize("NFKD"),
    EffectString.replace(DIACRITICS, ""),
    EffectString.toLowerCase,
    EffectString.replace(NON_SLUG_CHARACTERS, "-"),
    EffectString.replace(OUTER_HYPHENS, ""),
    EffectString.slice(0, 40),
    EffectString.replace(TRAILING_HYPHENS, ""),
  );
  return base.length >= 3
    ? base
    : EffectString.slice(0, 40)(`${base}${base.length === 0 ? "" : "-"}workspace`);
};

/** `slug` with a numeric suffix that keeps it within 40 chars, e.g. `acme-2`. */
export const withSuffix: {
  (n: number): (slug: string) => string;
  (slug: string, n: number): string;
} = Fn.dual(2, (slug: string, n: number): string => {
  const suffix = `-${n}`;
  return `${Fn.pipe(slug, EffectString.slice(0, 40 - suffix.length), EffectString.replace(TRAILING_HYPHENS, ""))}${suffix}`;
});

// Bank details ------------------------------------------------------------------------------

const WHITESPACE = /\s+/g;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const DIGIT = /\d/;

export const normalizeIban = (iban: string): string =>
  Fn.pipe(iban, EffectString.replace(WHITESPACE, ""), EffectString.toUpperCase);

/** ISO 13616 structure and mod-97 check. */
export const isValidIban = (iban: string): boolean => {
  if (!IBAN.test(iban)) return false;
  const rearranged = EffectString.slice(4)(iban) + EffectString.slice(0, 4)(iban);
  let remainder = 0;
  for (const char of rearranged) {
    const value = DIGIT.test(char)
      ? char
      : String(Option.getOrElse(EffectString.charCodeAt(char, 0), () => Number.NaN) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

export const isValidBic = (bic: string): boolean => BIC_FORMAT.test(bic);

export const isValidEmail = (email: string): boolean =>
  email.length <= 254 && EMAIL_FORMAT.test(email);

// Branding images (W7) ----------------------------------------------------------------------

export const BRANDING_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

/** How many leading bytes decide each type's signature (W7). */
export const IMAGE_SIGNATURE_BYTES = { "image/png": 8, "image/jpeg": 3 } as const;

/** Whether the first bytes match the declared type's signature. */
export const matchesImageSignature: {
  (head: Uint8Array): (contentType: string) => boolean;
  (contentType: string, head: Uint8Array): boolean;
} = Fn.dual(2, (contentType: string, head: Uint8Array): boolean => {
  if (contentType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return EffectArray.every(png, (byte, i) => head[i] === byte);
  }
  if (contentType === "image/jpeg") {
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  return false;
});

export const FOOTER_MAX_LENGTH = 500;
export const MAX_DUE_DAYS = 365;
export const MAX_REMINDER_OFFSETS = 10;
const DAY_MILLIS = 24 * 60 * 60 * 1000;
/** Invitations expire 7 days after their last send. */
export const INVITATION_TTL_MILLIS = 7 * DAY_MILLIS;
/** C6: `resendInvitation` sends no second email within this window. */
export const RESEND_COOLDOWN_MILLIS = 60 * 1000;
/** Expired invitations stay listed this long. */
export const INVITATION_LIST_EXPIRED_MILLIS = 30 * DAY_MILLIS;
/** A former slug redirects this long (W6). */
export const SLUG_ALIAS_TTL_MILLIS = 90 * DAY_MILLIS;

/**
 * Keeps `StoreUnavailable` (it becomes `Unavailable{database}`) and turns every other failure into
 * a defect: for store calls whose NotFound, Conflict or UniqueViolation cannot happen after a lock.
 */
export const storeOnly = <A, R>(
  effect: Effect.Effect<A, StoreUnavailable | Conflict | NotFound | UniqueViolation, R>,
): Effect.Effect<A, StoreUnavailable, R> =>
  Effect.catchIf(
    effect,
    (error): error is Conflict | NotFound | UniqueViolation => error._tag !== "StoreUnavailable",
    Effect.die,
  );
