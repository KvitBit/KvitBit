/**
 * Parser for CNB `denni_kurz.txt`, the daily fixing in plain text:
 *
 *   21.11.2026 #226
 *   země|měna|množství|kód|kurz
 *   Austrálie|dolar|1|AUD|13,797
 *   Japonsko|jen|100|JPY|15,123
 *
 * The header carries the fixing date and its sequence number within the year. Rates use a
 * decimal comma and are CZK per `množství` units of the currency.
 */

import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const HEADER = /^(\d{2})\.(\d{2})\.(\d{4}) #(\d+)$/;
const COLUMNS = Arr.join(["země", "měna", "množství", "kód", "kurz"], "|");
const lineBreak = /\r?\n/;
const QUANTITY = /^[1-9]\d*$/;
const RATE = /^\d+(?:,\d+)?$/;

const isCurrencyCode = Schema.is(CurrencyCode);
const isIsoDate = Schema.is(IsoDate);

/** A feed that does not have the expected shape. Its message names the offending line. */
export class MalformedFeed extends Schema.TaggedError<
  MalformedFeed,
  { readonly brand: unique symbol }
>()("MalformedFeed", { message: Schema.String }) {}

/** Parses one daily fixing. Fails with `MalformedFeed` when a line is invalid. */
export const parseDailyTxt = Effect.fn("parseDailyTxt")(function* (
  text: string,
): Effect.fn.Return<CnbFixing, MalformedFeed> {
  const lines = Arr.filter(
    Arr.map(Str.split(text, lineBreak), (line) => Str.trim(line)),
    (line) => line !== "",
  );
  const [header = "", columns = "", ...rows] = lines;

  const match = HEADER.exec(header);
  const fixingDate = match === null ? "" : `${match[3]}-${match[2]}-${match[1]}`;
  if (match === null || !isIsoDate(fixingDate)) {
    return yield* MalformedFeed.make({ message: `bad header: ${header}` });
  }
  if (columns !== COLUMNS)
    return yield* MalformedFeed.make({ message: `bad column header: ${columns}` });
  if (rows.length === 0) return yield* MalformedFeed.make({ message: "no rates" });

  const sequence = Number(match[4]);
  if (!Number.isSafeInteger(sequence))
    return yield* MalformedFeed.make({ message: `bad header: ${header}` });

  const seen = new Set<string>();
  const rates: Array<CnbFixing["rates"][number]> = [];
  for (const row of rows) {
    const cells = Str.split(row, "|");
    const [, , quantity = "", code = "", rate = ""] = cells;
    if (
      cells.length !== 5 ||
      !isCurrencyCode(code) ||
      !QUANTITY.test(quantity) ||
      !Number.isSafeInteger(Number(quantity))
    ) {
      return yield* MalformedFeed.make({ message: `bad row: ${row}` });
    }
    if (seen.has(code)) return yield* MalformedFeed.make({ message: `duplicate currency: ${row}` });
    seen.add(code);
    const value = RATE.test(rate)
      ? BigDecimal.fromString(Str.replace(",", ".")(rate))
      : Option.none();
    if (Option.isNone(value) || !BigDecimal.isPositive(value.value)) {
      return yield* MalformedFeed.make({ message: `bad rate: ${row}` });
    }
    rates.push({ code, quantity: Number(quantity), rate: BigDecimal.normalize(value.value) });
  }

  return { fixingDate, sequence, rates };
});
