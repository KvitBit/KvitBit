/**
 * CSV encoding for report exports and the full data export (flow 9.7).
 *
 * - RFC 4180 records: CRLF after every record (header included), a field is quoted when it
 *   holds the delimiter, a double quote, CR or LF, and quotes inside are doubled.
 * - Locale: `cs` uses the Czech convention spreadsheet software expects, `;` between fields
 *   and a decimal comma (`1234,50`); `en` uses `,` and a decimal point. Numbers carry no
 *   thousands separator; money has exactly 2 decimals; dates are ISO `YYYY-MM-DD`.
 * - A UTF-8 byte order mark starts the file so spreadsheets detect the encoding.
 * - Text cells that a spreadsheet would run as a formula (leading `=`, `+`, `-`, `@`, tab or
 *   CR) get a leading `'` (CSV injection, OWASP); number cells never do.
 * - Output is deterministic: rows come in the report's own order, no timestamps.
 */
import type { CurrencyCode, Locale } from "@kvitbit/domain/contract";
import { MoneyMath } from "@kvitbit/domain/contract";
import { BigDecimal, Stream } from "effect";
import { roundAt } from "../../engines/decimal";

export type CsvCell =
  | { readonly _tag: "text"; readonly value: string | null }
  | { readonly _tag: "number"; readonly value: BigDecimal.BigDecimal; readonly scale?: number }
  | { readonly _tag: "int"; readonly value: number };

export const text = (value: string | null): CsvCell => ({ _tag: "text", value });
/** A decimal; `scale` fixes the decimals (money: 2), else the value's own digits. */
export const num = (value: BigDecimal.BigDecimal, scale?: number): CsvCell =>
  scale === undefined ? { _tag: "number", value } : { _tag: "number", value, scale };
/** A CZK report figure: always 2 decimals (VAT and FX results are round2). */
export const money = (value: BigDecimal.BigDecimal): CsvCell => num(value, 2);
/**
 * An amount in its own currency: at least 2 decimals, the currency's minor-unit scale (3 for
 * BHD) and any finer stored digits, so no stored precision is lost.
 */
export const amount = (value: BigDecimal.BigDecimal, currency: CurrencyCode): CsvCell =>
  num(value, Math.max(2, MoneyMath.minorUnitScale(currency), BigDecimal.normalize(value).scale));
export const int = (value: number): CsvCell => ({ _tag: "int", value });

export interface CsvTable {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<CsvCell>>;
}

export interface CsvDialect {
  readonly delimiter: "," | ";";
  readonly decimal: "." | ",";
}

export const dialectFor = (locale: Locale): CsvDialect =>
  locale === "cs" ? { delimiter: ";", decimal: "," } : { delimiter: ",", decimal: "." };

/** Plain decimal notation (never exponent), `scale` decimals when given. */
export const formatDecimal = (
  value: BigDecimal.BigDecimal,
  decimal: "." | ",",
  scale?: number,
): string => {
  let digits: bigint;
  let places: number;
  if (scale === undefined) {
    const n = BigDecimal.normalize(value);
    digits = n.value;
    places = Math.max(0, n.scale);
    if (n.scale < 0) digits = n.value * 10n ** BigInt(-n.scale);
  } else {
    const r = roundAt(value, scale);
    places = scale;
    digits = r.scale <= scale ? r.value * 10n ** BigInt(scale - r.scale) : r.value;
  }
  const negative = digits < 0n;
  const abs = (negative ? -digits : digits).toString().padStart(places + 1, "0");
  const whole = abs.slice(0, abs.length - places);
  const fraction = abs.slice(abs.length - places);
  const body = places === 0 ? whole : `${whole}${decimal}${fraction}`;
  return negative ? `-${body}` : body;
};

const FORMULA_START = /^[=+\-@\t\r]/;

export const encodeField = (raw: string, dialect: CsvDialect): string =>
  raw.includes(dialect.delimiter) || raw.includes('"') || raw.includes("\r") || raw.includes("\n")
    ? `"${raw.replaceAll('"', '""')}"`
    : raw;

const cellText = (cell: CsvCell, dialect: CsvDialect): string => {
  switch (cell._tag) {
    case "text":
      if (cell.value === null) return "";
      return FORMULA_START.test(cell.value) ? `'${cell.value}` : cell.value;
    case "number":
      return formatDecimal(cell.value, dialect.decimal, cell.scale);
    case "int":
      return String(cell.value);
  }
};

export const encodeRecord = (fields: ReadonlyArray<string>, dialect: CsvDialect): string =>
  `${fields.map((f) => encodeField(f, dialect)).join(dialect.delimiter)}\r\n`;

export const BOM = "﻿";

/** The records of `table` as strings: BOM + header, then one per row. */
export const csvLines = (table: CsvTable, locale: Locale): ReadonlyArray<string> => {
  const dialect = dialectFor(locale);
  return [
    BOM + encodeRecord(table.header, dialect),
    ...table.rows.map((row) =>
      encodeRecord(
        row.map((c) => cellText(c, dialect)),
        dialect,
      ),
    ),
  ];
};

export const encodeCsv = (table: CsvTable, locale: Locale): string =>
  csvLines(table, locale).join("");

/** UTF-8 byte stream, one chunk per record, each row encoded only when pulled (exports stream rows). */
export const csvStream = (table: CsvTable, locale: Locale): Stream.Stream<Uint8Array> => {
  const dialect = dialectFor(locale);
  const encoder = new TextEncoder();
  return Stream.concat(
    Stream.sync(() => encoder.encode(BOM + encodeRecord(table.header, dialect))),
    Stream.fromIterable(table.rows).pipe(
      Stream.map((row) =>
        encoder.encode(
          encodeRecord(
            row.map((c) => cellText(c, dialect)),
            dialect,
          ),
        ),
      ),
    ),
  );
};

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";
