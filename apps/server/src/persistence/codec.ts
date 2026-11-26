/**
 * Small serialization helpers shared by the SQL repositories: BigDecimal <-> text, JSONB parsing,
 * `VatBreakdown` JSON encoding/decoding, and diacritics-insensitive text folding matching core.
 */
import type { VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import {
  VatBreakdown as VatBreakdownSchema,
  VatBucket as VatBucketSchema,
} from "@kvitbit/domain/contract";
import { BigDecimal, Schema } from "effect";

const vatBreakdownJson = Schema.toCodecJson(VatBreakdownSchema);
const vatBucketJson = Schema.toCodecJson(VatBucketSchema);

export const encodeVatBreakdown = Schema.encodeSync(vatBreakdownJson);
export const decodeVatBreakdown = Schema.decodeUnknownSync(vatBreakdownJson);
export const encodeVatBucket = Schema.encodeSync(vatBucketJson);
export const decodeVatBucket = Schema.decodeUnknownSync(vatBucketJson);

/** Parses a `jsonb` column whether the driver returned a parsed value or a JSON string. */
export const parseJson = <A>(value: unknown): A =>
  (typeof value === "string" ? JSON.parse(value) : value) as A;

/** Encodes a value for a `jsonb` parameter, returning `null` for `null`/`undefined`. */
export const toJsonb = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/** Postgres `numeric::text` -> `BigDecimal`. */
export const parseDecimal = (value: unknown): BigDecimal.BigDecimal =>
  BigDecimal.fromStringUnsafe(String(value));

export const parseNullableDecimal = (value: unknown): BigDecimal.BigDecimal | null =>
  value === null || value === undefined ? null : parseDecimal(value);

/** `BigDecimal` -> plain decimal string for Postgres `numeric` parameters. */
export const formatDecimal = (value: BigDecimal.BigDecimal): string => BigDecimal.format(value);

export const formatNullableDecimal = (value: BigDecimal.BigDecimal | null): string | null =>
  value === null ? null : formatDecimal(value);

/** Normalizes Postgres array columns (handles both driver arrays and `{a,b}` enum-array text). */
export const asStringArray = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value as ReadonlyArray<string>;
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    if (inner.length === 0) return [];
    return inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
  }
  return [];
};

export const asNumberArray = (value: unknown): ReadonlyArray<number> => {
  if (Array.isArray(value)) return (value as ReadonlyArray<unknown>).map(Number);
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    if (inner.length === 0) return [];
    return inner.split(",").map(Number);
  }
  return [];
};

/** Formats a string array as a Postgres array literal (`{a,b}`) for custom enum array columns. */
export const toPgArray = (values: ReadonlyArray<string>): string =>
  `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;

/** Case- and diacritics-insensitive text folding (matches `packages/core/src/modules/contacts/input.ts`). */
export const foldText = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

export type { VatBreakdown, VatBucket };
