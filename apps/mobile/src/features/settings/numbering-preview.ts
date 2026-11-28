import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";

const COUNTER_TOKEN = /(N+)/;
const HAS_COUNTER_TOKEN = /N+/;

export const hasCounterToken = (pattern: string): boolean => HAS_COUNTER_TOKEN.test(pattern);

export const formatSeriesNumber: {
  (counter: number, date?: Date): (pattern: string) => string | null;
  (pattern: string, counter: number, date?: Date): string | null;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (
    pattern: string,
    counter: number,
    date: Date = DateTime.toDateUtc(DateTime.nowUnsafe()),
  ): string | null => {
    if (!(hasCounterToken(pattern) && Number.isInteger(counter)) || counter < 1) return null;
    const year = String(date.getFullYear());
    const shortYear = Str.slice(-2)(year);
    const month = Str.padStart(2, "0")(String(date.getMonth() + 1));
    const datedPattern = Str.replace(
      /MM/g,
      month,
    )(Str.replace(/YY/g, shortYear)(Str.replace(/YYYY/g, year)(pattern)));
    return Arr.join(
      Arr.map(Str.split(COUNTER_TOKEN)(datedPattern), (part, index) =>
        index % 2 === 0 ? part : Str.padStart(part.length, "0")(String(counter)),
      ),
      "",
    );
  },
);

/** Previews the next `count` numbers (default 3) starting at `startCounter`. */
export const previewSeriesNumbers: {
  (
    startCounter: number,
    date?: Date,
    count?: number,
  ): (pattern: string) => ReadonlyArray<string> | null;
  (
    pattern: string,
    startCounter: number,
    date?: Date,
    count?: number,
  ): ReadonlyArray<string> | null;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (
    pattern: string,
    startCounter: number,
    date: Date = DateTime.toDateUtc(DateTime.nowUnsafe()),
    count = 3,
  ): ReadonlyArray<string> | null => {
    if (!(hasCounterToken(pattern) && Number.isInteger(startCounter)) || startCounter < 1) {
      return null;
    }
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const formatted = formatSeriesNumber(pattern, startCounter + i, date);
      if (formatted === null) return null;
      out.push(formatted);
    }
    return out;
  },
);
