/**
 * Small serialization helpers shared by the SQL repositories: BigDecimal <-> text, JSONB parsing,
 * `VatBreakdown` JSON encoding/decoding, and diacritics-insensitive text folding matching core.
 */
import { type IsoDate, VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { DbValue } from "./table";

export const VatBreakdownJson = Schema.toCodecJson(VatBreakdown);
export const VatBucketJson = Schema.toCodecJson(VatBucket);

/** Some migrated rows store UUIDv4 keys. A read must preserve those keys. */
export const StoredUuid = Schema.String.check(Schema.isUUID());

/** The row codec runs inside the repository Effect. An invalid stored value is a defect. */
export const decodeStored = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeResult(schema);
  return (value: DbValue | object): S["Type"] => Result.getOrThrow(decode(value));
};

const isString = Schema.is(Schema.String);
const decodeJsonText = decodeStored(Schema.fromJsonString(Schema.Json));

export const encodeStored = <S extends Schema.ConstraintEncoder<unknown>>(schema: S) => {
  const encode = Schema.encodeResult(schema);
  return (value: S["Type"]): S["Encoded"] => Result.getOrThrow(encode(value));
};

export const encodeVatBreakdown = encodeStored(VatBreakdownJson);
export const encodeVatBucket = encodeStored(VatBucketJson);

/** PostgreSQL calls ISO year zero `0001 BC`. The full export range starts in ISO year zero. */
export const toPgDate = (value: IsoDate): string =>
  Str.startsWith("0000-")(value) ? `0001-${Str.slice(5)(value)} BC` : value;

/** Parses a `jsonb` column whether the driver returned a parsed value or a JSON string. */
export const parseJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = decodeStored(schema);
  return (value: DbValue): S["Type"] => decode(isString(value) ? decodeJsonText(value) : value);
};

export const encodeJson = encodeStored(Schema.fromJsonString(Schema.Unknown));

/** Encodes a value for a `jsonb` parameter, returning `null` for `null`/`undefined`. */
export const toJsonb = (value: object | null | undefined): string | null =>
  value === null || value === undefined ? null : encodeJson(value);

/** Postgres `numeric::text` -> `BigDecimal`. */
export const parseDecimal = (value: DbValue): BigDecimal.BigDecimal =>
  BigDecimal.fromStringUnsafe(String(value));

export const parseNullableDecimal = (value: DbValue): BigDecimal.BigDecimal | null =>
  value === null || value === undefined ? null : parseDecimal(value);

/** `BigDecimal` -> plain decimal string for Postgres `numeric` parameters. */
export const formatDecimal = (value: BigDecimal.BigDecimal): string => BigDecimal.format(value);

export const formatNullableDecimal = (value: BigDecimal.BigDecimal | null): string | null =>
  value === null ? null : formatDecimal(value);

/** Normalizes Postgres array columns (handles both driver arrays and `{a,b}` enum-array text). */
const readStringArray = decodeStored(Schema.Array(Schema.String));
export const asStringArray = (value: DbValue): ReadonlyArray<string> => {
  if (Arr.isArray(value)) return readStringArray(value);
  if (isString(value) && Str.startsWith("{")(value) && Str.endsWith("}")(value)) {
    const inner = Str.slice(1, -1)(value);
    if (inner.length === 0) return [];
    return Arr.map(Str.split(inner, ","), (s) => Str.replace(/^"|"$/g, "")(s));
  }
  return [];
};

export const asNumberArray = (value: DbValue): ReadonlyArray<number> => {
  if (Arr.isArray(value)) return Arr.map(value, Number);
  if (isString(value) && Str.startsWith("{")(value) && Str.endsWith("}")(value)) {
    const inner = Str.slice(1, -1)(value);
    if (inner.length === 0) return [];
    return Arr.map(Str.split(inner, ","), Number);
  }
  return [];
};

/** Formats a string array as a Postgres array literal (`{a,b}`) for custom enum array columns. */
export const toPgArray = (values: ReadonlyArray<string>): string =>
  `{${Arr.join(
    Arr.map(values, (v) => `"${Str.replace(/"/g, '\\"')(Str.replace(/\\/g, "\\\\")(v))}"`),
    ",",
  )}}`;

/** Case- and diacritics-insensitive text folding (matches `packages/core/src/modules/contacts/input.ts`). */
export const foldText = (text: string): string =>
  Fn.pipe(
    text,
    Str.normalize("NFD"),
    Str.replace(/\p{Diacritic}/gu, ""),
    Str.toLowerCase,
    Str.trim,
  );
