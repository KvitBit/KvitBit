/** Material 3 tonal palette: one hue and chroma, any tone 0..100, memoized per tone. */
import { Hct } from "./hct";
import { type Rgb, sanitizeDegrees } from "./utils";

/** The tones Material 3 tooling exports, including the surface steps of the 2023 spec. */
export const PALETTE_TONES = [
  0, 4, 5, 6, 10, 12, 15, 17, 20, 22, 24, 25, 30, 35, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96,
  98, 99, 100,
] as const;

export class TonalPalette {
  private readonly cache = new Map<number, Rgb>();

  private constructor(
    readonly hue: number,
    readonly chroma: number,
  ) {}

  static fromHueAndChroma(hue: number, chroma: number): TonalPalette {
    return new TonalPalette(sanitizeDegrees(hue), Math.max(0, chroma));
  }

  static fromRgb(rgb: Rgb): TonalPalette {
    const hct = Hct.fromRgb(rgb);
    return new TonalPalette(hct.hue, hct.chroma);
  }

  tone(tone: number): Rgb {
    const key = Math.round(tone * 100) / 100;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const rgb = Hct.from(this.hue, this.chroma, key).rgb;
    this.cache.set(key, rgb);
    return rgb;
  }
}
