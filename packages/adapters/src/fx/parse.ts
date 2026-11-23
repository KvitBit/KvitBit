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
import { BigDecimal, Option, Schema } from "effect";

const HEADER = /^(\d{2})\.(\d{2})\.(\d{4}) #(\d+)$/;
const COLUMNS = "země|měna|množství|kód|kurz";
const QUANTITY = /^[1-9]\d*$/;
const RATE = /^\d+(?:,\d+)?$/;

const isCurrencyCode = Schema.is(CurrencyCode);
const isIsoDate = Schema.is(IsoDate);

/** A feed that does not have the expected shape. Its message names the offending line. */
export class MalformedFeed extends Error {
  override readonly name = "MalformedFeed";
}

/** Parses one daily fixing. Throws `MalformedFeed` on any deviation from the format. */
export const parseDailyTxt = (text: string): CnbFixing => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const [header = "", columns = "", ...rows] = lines;

  const match = HEADER.exec(header);
  const fixingDate = match ? `${match[3]}-${match[2]}-${match[1]}` : "";
  if (!match || !isIsoDate(fixingDate)) throw new MalformedFeed(`bad header: ${header}`);
  if (columns !== COLUMNS) throw new MalformedFeed(`bad column header: ${columns}`);
  if (rows.length === 0) throw new MalformedFeed("no rates");

  const rates = rows.map((row) => {
    const cells = row.split("|");
    const [, , quantity = "", code = "", rate = ""] = cells;
    if (cells.length !== 5 || !isCurrencyCode(code) || !QUANTITY.test(quantity)) {
      throw new MalformedFeed(`bad row: ${row}`);
    }
    const value = RATE.test(rate) ? BigDecimal.fromString(rate.replace(",", ".")) : Option.none();
    if (Option.isNone(value)) throw new MalformedFeed(`bad rate: ${row}`);
    return { code, quantity: Number(quantity), rate: BigDecimal.normalize(value.value) };
  });

  return { fixingDate, sequence: Number(match[4]), rates };
};
