/** WCAG 2.x relative luminance and contrast ratio. */
import * as Fn from "effect/Function";
import { blueOf, greenOf, linearized, type Rgb, redOf } from "./utils";

/** WCAG relative luminance, 0..1. */
export const relativeLuminance = (rgb: Rgb): number =>
  (0.2126 * linearized(redOf(rgb)) +
    0.7152 * linearized(greenOf(rgb)) +
    0.0722 * linearized(blueOf(rgb))) /
  100;

/** WCAG contrast ratio, 1..21, order-independent. */
export const contrastRatio: {
  (b: Rgb): (a: Rgb) => number;
  (a: Rgb, b: Rgb): number;
} = Fn.dual(2, (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
});
