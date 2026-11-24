/** Seeded generator for property tests (fast-check is not a dependency). mulberry32. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <A>(items: ReadonlyArray<A>): A => items[int(0, items.length - 1)] as A;
  /** A decimal string with up to `scale` decimals in [-max, max] (or [0, max]). */
  const decimal = (max: number, scale: number, signed = true): string => {
    const units = int(0, max * 10 ** scale);
    const sign = signed && next() < 0.3 ? "-" : "";
    const s = String(units).padStart(scale + 1, "0");
    return scale === 0 ? `${sign}${s}` : `${sign}${s.slice(0, -scale)}.${s.slice(-scale)}`;
  };
  return { next, int, pick, decimal };
};

export const SEEDS = Array.from({ length: 300 }, (_, i) => 0x5eed + i * 7919);
