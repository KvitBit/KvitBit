import * as Fn from "effect/Function";
import * as Str from "effect/String";

const PAINT_PATTERN = /^(?:currentColor|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8})$/u;

/** Accepts `currentColor` or a hex color; rejects anything that could break out of an SVG attribute. */
export const assertPaint = (paint: string): string => {
  if (!PAINT_PATTERN.test(paint)) {
    throw new TypeError(
      `Invalid SVG paint "${paint}": expected currentColor or #RGB/#RRGGBB/#RRGGBBAA`,
    );
  }
  return paint;
};

export const escapeXmlText = (text: string): string =>
  Fn.pipe(
    text,
    Str.replaceAll("&", "&amp;"),
    Str.replaceAll("<", "&lt;"),
    Str.replaceAll(">", "&gt;"),
  );
