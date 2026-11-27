/**
 * Pure numbering series pattern validation & preview (flow 10.5).
 * Tokens: YYYY (4-digit year), YY (2-digit year), MM (2-digit month), N… (zero-padded counter).
 */
const COUNTER_TOKEN = /N+/g;

export const hasCounterToken = (pattern: string): boolean => /N+/.test(pattern);

export const formatSeriesNumber = (
  pattern: string,
  counter: number,
  date: Date = new Date(),
): string | null => {
  if (!hasCounterToken(pattern) || !Number.isInteger(counter) || counter < 1) return null;
  const year = String(date.getFullYear());
  const shortYear = year.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return pattern
    .replace(/YYYY/g, year)
    .replace(/YY/g, shortYear)
    .replace(/MM/g, month)
    .replace(COUNTER_TOKEN, (match) => String(counter).padStart(match.length, "0"));
};

/** Previews the next `count` numbers (default 3) starting at `startCounter`. */
export const previewSeriesNumbers = (
  pattern: string,
  startCounter: number,
  date: Date = new Date(),
  count = 3,
): ReadonlyArray<string> | null => {
  if (!hasCounterToken(pattern) || !Number.isInteger(startCounter) || startCounter < 1) {
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const formatted = formatSeriesNumber(pattern, startCounter + i, date);
    if (formatted === null) return null;
    out.push(formatted);
  }
  return out;
};
