/** The self-contained A4 HTML page every template renders into. */

import type { Locale } from "@kvitbit/domain";
import * as Fn from "effect/Function";
import { escapeHtml } from "./format";

/**
 * The mockups lay the sheet out at 688 px wide; `zoom` scales it to the 210 mm A4 width
 * (794 px at 96 dpi), so every mockup measurement carries over unchanged.
 */
export const SHEET_ZOOM = 794 / 688;

/**
 * No network: fonts fall back from the brand faces (used only when installed on the render
 * host) to system faces. Colours are forced in print.
 */
const BASE_CSS = `
@page { size: A4; margin: 10mm 0 10mm; }
@page :first { margin-top: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #FFFFFF; }
body { color: #09090B; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { position: relative; width: 688px; margin: 0 auto; zoom: ${SHEET_ZOOM.toFixed(4)}; }
.tnum { font-variant-numeric: lining-nums tabular-nums; font-feature-settings: "lnum" 1, "tnum" 1; }
.mono { font-family: 'JetBrains Mono', 'DejaVu Sans Mono', 'Liberation Mono', ui-monospace, monospace !important; }
.watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 5; }
.watermark span { font-weight: 600; font-size: 85px; text-transform: uppercase; color: rgba(185, 28, 28, 0.11); border: 4.6px solid rgba(185, 28, 28, 0.12); padding: 7px 30px; transform: rotate(-28deg); }
.r { text-align: right; white-space: nowrap; }
.neg { color: #B91C1C; }
tr, .keep { break-inside: avoid; }
.logo-img { max-height: 34px; max-width: 120px; object-fit: contain; display: block; }
.stamp-img { max-height: 72px; max-width: 180px; object-fit: contain; display: block; margin-top: 6px; }
/* DESIGN.md: horizontal lockup at least 5 mm tall in print, clear space 2u (half the mark height) on every side; lengths are divided by the sheet zoom. */
.brand-lockup { display: inline-block; padding: ${(2.5 / SHEET_ZOOM).toFixed(3)}mm; line-height: 0; }
.brand-lockup svg { display: block; height: ${(5 / SHEET_ZOOM).toFixed(3)}mm; width: auto; }
.qr svg { display: block; width: 100%; height: 100%; }
`;

export const page = (input: {
  readonly lang: Locale;
  readonly title: string;
  readonly css: string;
  readonly accent: string;
  readonly tint: string;
  readonly body: string;
}): string =>
  `<!DOCTYPE html>
<html lang="${input.lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>${BASE_CSS}
:root { --p-accent: ${input.accent}; --p-tint: ${input.tint}; }
${input.css}</style>
</head>
<body>
${input.body}
</body>
</html>
`;

export const watermark: {
  (text: string): (draft: boolean) => string;
  (draft: boolean, text: string): string;
} = Fn.dual(2, (draft: boolean, text: string): string =>
  draft
    ? `<div class="watermark" data-watermark="draft"><span>${escapeHtml(text)}</span></div>`
    : "",
);
