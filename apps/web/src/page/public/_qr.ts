import type { Html } from "@effect/ui/html";
import { type Markup, svgImage } from "../../ui/html";
/**
 * ISO/IEC 18004 SVG QR renderer for SPAYD / EPC payment payloads (via `uqr`).
 * Keeps the symbol and its quiet zone high contrast under every share theme.
 * Private to src/page/public/.
 */

import { encode } from "uqr";

const QUIET_ZONE = 4;

/** Builds a scannable ISO 18004 QR SVG string with a 4-module quiet zone from `payload`. */
export const qrSvgMarkup = (payload: string, sizePx = 168): string => {
  const result = encode(payload, { ecc: "M", border: 0 });
  const size = result.size;
  const rects: Array<string> = [];
  for (let r = 0; r < size; r++) {
    const row = result.data[r];
    if (row === undefined) continue;
    for (let c = 0; c < size; c++) {
      if (row[c]) {
        rects.push(`<rect x="${c + QUIET_ZONE}" y="${r + QUIET_ZONE}" width="1" height="1"/>`);
      }
    }
  }
  const viewBox = size + QUIET_ZONE * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${viewBox} ${viewBox}" fill="black" shape-rendering="crispEdges" focusable="false" aria-hidden="true"><rect width="${viewBox}" height="${viewBox}" fill="white"/>${rects.join("")}</svg>`;
};

export const paymentQrView = <M>(
  h: Html.H<M>,
  payload: string,
  ariaLabel: string,
  sizePx = 168,
): Markup<M> =>
  h.div
    .class("kb-qr-frame")
    .attr("role", "img")
    .attr("aria-label", ariaLabel)
    .children([h.img.attr("src", svgImage(qrSvgMarkup(payload, sizePx))).attr("alt", "")]);
