/**
 * Payment QR as SVG. Module matrix from `qrcode` (error correction M, as DeskoHub
 * `packages/qr-code` and CBA QR Platba 1.2 recommend); the SVG is written here as one path so the
 * output is synchronous and byte-for-byte deterministic for a given payload and options.
 */

import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { create } from "qrcode";

export interface QrSvgOptions {
  /** Quiet zone in modules. Default 4 (ISO/IEC 18004). */
  readonly margin?: number;
  /** Dark module colour, `#RGB` or `#RRGGBB`. Default black. */
  readonly color?: string;
  /** Accessible label; omitted makes the SVG decorative (`aria-hidden`). */
  readonly title?: string;
}

const escapeXml = (text: string): string =>
  Fn.pipe(
    text,
    Str.replaceAll("&", "&amp;"),
    Str.replaceAll("<", "&lt;"),
    Str.replaceAll(">", "&gt;"),
    Str.replaceAll('"', "&quot;"),
  );

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

const buildSvg = (payload: string, options: QrSvgOptions): Result.Result<string, RangeError> => {
  if (payload === "") return Result.fail(new RangeError("QR payload must not be empty"));
  const margin = options.margin ?? 4;
  if (!Number.isInteger(margin) || margin < 0) {
    return Result.fail(
      new RangeError(`Invalid QR margin ${margin}: expected a non-negative integer`),
    );
  }
  const color = options.color ?? "#000000";
  if (!HEX_COLOR.test(color)) {
    return Result.fail(new RangeError(`Invalid QR colour ${color}: expected #RGB or #RRGGBB`));
  }
  const { modules } = create(payload, { errorCorrectionLevel: "M" });
  const size = modules.size;
  const full = size + margin * 2;
  let d = "";
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (modules.get(row, col) === 0) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && modules.get(row, col) !== 0) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  const label =
    options.title === undefined
      ? ' aria-hidden="true"'
      : ` role="img" aria-label="${escapeXml(options.title)}"`;
  return Result.succeed(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"${label}><rect width="${full}" height="${full}" fill="#FFFFFF"/><path fill="${color}" d="${d}"/></svg>`,
  );
};

export const toSvg: {
  (options?: QrSvgOptions): (payload: string) => string;
  (payload: string, options?: QrSvgOptions): string;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (payload: string, options: QrSvgOptions = {}): string =>
    Result.getOrThrow(buildSvg(payload, options)),
);
