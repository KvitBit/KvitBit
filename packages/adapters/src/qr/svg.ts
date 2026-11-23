/**
 * Payment QR as SVG. Module matrix from `qrcode` (error correction M, as DeskoHub
 * `packages/qr-code` and CBA QR Platba 1.2 recommend); the SVG is written here as one path so the
 * output is synchronous and byte-for-byte deterministic for a given payload and options.
 */
import QRCode from "qrcode";

export interface QrSvgOptions {
  /** Quiet zone in modules. Default 4 (ISO/IEC 18004). */
  readonly margin?: number;
  /** Dark module colour, `#RGB` or `#RRGGBB`. Default black. */
  readonly color?: string;
  /** Accessible label; omitted makes the SVG decorative (`aria-hidden`). */
  readonly title?: string;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const toSvg = (payload: string, options: QrSvgOptions = {}): string => {
  if (payload === "") throw new RangeError("QR payload must not be empty");
  const margin = options.margin ?? 4;
  if (!Number.isInteger(margin) || margin < 0) {
    throw new RangeError(`Invalid QR margin ${margin}: expected a non-negative integer`);
  }
  const color = options.color ?? "#000000";
  if (!/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(color)) {
    throw new RangeError(`Invalid QR colour ${color}: expected #RGB or #RRGGBB`);
  }
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = modules.size;
  const full = size + margin * 2;
  let d = "";
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && modules.get(row, col)) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  const label =
    options.title === undefined
      ? ' aria-hidden="true"'
      : ` role="img" aria-label="${escapeXml(options.title)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"${label}><rect width="${full}" height="${full}" fill="#FFFFFF"/><path fill="${color}" d="${d}"/></svg>`;
};
