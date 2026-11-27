/** Material 3 tonal palette: one hue and chroma, any tone 0..100, memoized per tone. */
import { Hct } from "./hct";
import { type Rgb, sanitizeDegrees } from "./utils";

export class TonalPalette {
  readonly hue: number;
  readonly chroma: number;
  private readonly cache = new Map<number, Rgb>();

  private constructor(hue: number, chroma: number) {
    this.hue = hue;
    this.chroma = chroma;
  }

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
