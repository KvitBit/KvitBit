/** Pure rules and validation helpers of the Workspaces module. */
import type { IsoDate, Issue, IssueCode, TaxRegime } from "@kvitbit/domain/contract";
import { Invalid, WorkspaceSlug } from "@kvitbit/domain/contract";
import { Clock, Effect, Schema } from "effect";
import type { TaxRegimePeriod } from "./model";

export const issue = (
  path: ReadonlyArray<string | number>,
  code: IssueCode,
  params?: Record<string, string>,
): Issue => ({ path: [...path], code, ...(params === undefined ? {} : { params }) });

export const invalid = (path: ReadonlyArray<string | number>, code: IssueCode) =>
  new Invalid({ issues: [issue(path, code)] });

/** Fails with every collected issue, or succeeds when there are none. */
export const failIssues = (issues: ReadonlyArray<Issue>): Effect.Effect<void, Invalid> => {
  const [first, ...rest] = issues;
  return first === undefined ? Effect.void : Effect.fail(new Invalid({ issues: [first, ...rest] }));
};

/** Decodes an open or opaque domain input with its concrete schema; failure is `request.malformed`. */
export const decodeInput = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): Effect.Effect<A, Invalid> =>
  Effect.mapError(Schema.decodeUnknownEffect(schema)(value), () =>
    invalid(path, "request.malformed"),
  );

// Dates -------------------------------------------------------------------------------------

const PRAGUE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date in Europe/Prague at `millis`. */
export const pragueDate = (millis: number): IsoDate => PRAGUE.format(new Date(millis)) as IsoDate;

export const today: Effect.Effect<IsoDate> = Effect.map(Clock.currentTimeMillis, pragueDate);

export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) =>
  new Date(ms).toISOString(),
);

export const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** The Tax Regime in force on `date` (W2); periods are sorted and never empty. */
export const regimeOn = (periods: ReadonlyArray<TaxRegimePeriod>, date: IsoDate): TaxRegime => {
  let regime = periods[0]?.regime ?? "non_vat_payer";
  for (const period of periods) if (period.effectiveFrom <= date) regime = period.regime;
  return regime;
};

// Slugs (W6) --------------------------------------------------------------------------------

export const isValidSlug = (slug: string): boolean => Schema.is(WorkspaceSlug)(slug);

/** A slug candidate from a name: ASCII-folded, lowercase, hyphenated, 3 to 40 chars. */
export const slugify = (name: string): string => {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `${base}${base.length === 0 ? "" : "-"}workspace`.slice(0, 40);
};

/** `slug` with a numeric suffix that keeps it within 40 chars, e.g. `acme-2`. */
export const withSuffix = (slug: string, n: number): string => {
  const suffix = `-${n}`;
  return `${slug.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
};

// Bank details ------------------------------------------------------------------------------

export const normalizeIban = (iban: string): string => iban.replace(/\s+/g, "").toUpperCase();

/** ISO 13616 structure and mod-97 check. */
export const isValidIban = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

export const isValidBic = (bic: string): boolean =>
  /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic);

export const isValidEmail = (email: string): boolean =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Branding images (W7) ----------------------------------------------------------------------

export const BRANDING_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

/** Whether the first bytes match the declared type's signature. */
export const matchesImageSignature = (contentType: string, head: Uint8Array): boolean => {
  if (contentType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return png.every((byte, i) => head[i] === byte);
  }
  if (contentType === "image/jpeg") {
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  return false;
};

export const FOOTER_MAX_LENGTH = 500;
export const MAX_DUE_DAYS = 365;
export const MAX_REMINDER_OFFSETS = 10;
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
export const storeOnly = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Extract<E, { readonly _tag: "StoreUnavailable" }>, R> =>
  Effect.catchIf(
    effect,
    (error) => error._tag !== "StoreUnavailable",
    (error) => Effect.die(error),
  ) as Effect.Effect<A, Extract<E, { readonly _tag: "StoreUnavailable" }>, R>;
