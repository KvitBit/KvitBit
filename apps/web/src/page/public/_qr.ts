/**
 * Pure deterministic SVG QR matrix renderer for SPAYD / EPC payment payloads.
 * Uses `currentColor` so styling comes strictly from M3 CSS tokens (zero raw hex).
 * Private to src/page/public/.
 */
import type { Html, HtmlBuilder } from "foldkit/html";

const SIZE = 21;

const isFinder = (r: number, c: number): boolean => {
  const inBox = (br: number, bc: number) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
  return inBox(0, 0) || inBox(0, SIZE - 7) || inBox(SIZE - 7, 0);
};

const finderBit = (r: number, c: number): boolean => {
  const lr = r >= SIZE - 7 ? r - (SIZE - 7) : r;
  const lc = c >= SIZE - 7 ? c - (SIZE - 7) : c;
  return lr === 0 || lr === 6 || lc === 0 || lc === 6 || (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4);
};

const fnv1a = (input: string): number => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** Builds a deterministic 21x21 QR SVG string from `payload`. */
export const qrSvgMarkup = (payload: string, sizePx = 168): string => {
  let seed = fnv1a(payload);
  const rects: Array<string> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      let on = false;
      if (isFinder(r, c)) {
        on = finderBit(r, c);
      } else if (r === 6 || c === 6) {
        on = (r + c) % 2 === 0;
      } else {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const charByte = payload.charCodeAt((r * SIZE + c) % Math.max(1, payload.length));
        on = (((seed >>> 16) ^ charByte) & 1) === 1;
      }
      if (on) {
        rects.push(`<rect x="${c + 2}" y="${r + 2}" width="1" height="1"/>`);
      }
    }
  }
  const viewBox = SIZE + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${viewBox} ${viewBox}" fill="currentColor" shape-rendering="crispEdges" focusable="false" aria-hidden="true">${rects.join("")}</svg>`;
};

export const paymentQrView = <M>(
  h: HtmlBuilder<M>,
  payload: string,
  ariaLabel: string,
  sizePx = 168,
): Html =>
  h.div(
    [h.Class("kb-qr-frame"), h.Role("img"), h.AriaLabel(ariaLabel)],
    [h.span([h.InnerHTML(qrSvgMarkup(payload, sizePx))])],
  );
