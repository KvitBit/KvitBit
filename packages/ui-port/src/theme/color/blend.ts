/** Hue harmonization (material-color-utilities `Blend.harmonize`). */
import { Hct } from "./hct";
import { differenceDegrees, type Rgb, sanitizeDegrees } from "./utils";

const rotationDirection = (from: number, to: number): 1 | -1 =>
  sanitizeDegrees(to - from) <= 180 ? 1 : -1;

/**
 * Shift `design`'s hue toward `source`'s by half their difference, at most 15 degrees, keeping
 * its chroma and tone, so status colours sit in the same family as the theme's primary.
 */
export const harmonize = (design: Rgb, source: Rgb): Rgb => {
  const from = Hct.fromRgb(design);
  const to = Hct.fromRgb(source);
  const rotation = Math.min(differenceDegrees(from.hue, to.hue) * 0.5, 15);
  const hue = sanitizeDegrees(from.hue + rotation * rotationDirection(from.hue, to.hue));
  return Hct.from(hue, from.chroma, from.tone).rgb;
};
