import * as Str from "effect/String";
import { assertPaint } from "./svg";

/** T4 Micro-Glyph Graph tile edge length; the tile is seamless at this period. */
export const PATTERN_TILE_SIZE = 96 as const;
export const PATTERN_VIEW_BOX = "0 0 96 96";

/** Tile body with `{ink}` placeholders, verbatim from `assets/brand/pattern/kvitbit-pattern-t4*.svg`. */
const TILE_BODY = `  <path d="M0 0 H96 M0 48 H96 M0 96 H96 M0 0 V96 M48 0 V96 M96 0 V96" fill="none" stroke="{ink}" stroke-width="0.65" opacity="0.084"/>
  <path d="M0 48 L48 0 M48 96 L96 48" fill="none" stroke="{ink}" stroke-width="0.55" stroke-dasharray="2 3" opacity="0.078"/>
  <g fill="{ink}" opacity="0.434">
    <rect x="-2.5" y="-2.5" width="5" height="5"/>
    <rect x="93.5" y="-2.5" width="5" height="5"/>
    <rect x="-2.5" y="93.5" width="5" height="5"/>
    <rect x="93.5" y="93.5" width="5" height="5"/>
    <rect x="50" y="46.2" width="3.6" height="3.6"/>
  </g>
  <g fill="none" stroke="{ink}" opacity="0.322">
    <path d="M50 42 L44 48 L50 54" stroke-width="1.35" stroke-linecap="square"/>
    <path d="M48 -5 V-2 M48 2 V5 M48 91 V94 M48 98 V101" stroke-width="1.6"/>
    <rect x="-2.5" y="45.5" width="5" height="5" stroke-width="1.1"/>
    <rect x="93.5" y="45.5" width="5" height="5" stroke-width="1.1"/>
  </g>`;

const TILE_COMMENT =
  "  <!-- Kvitbit T4 Micro-Glyph Graph: seamless 96x96 tile. Elements crossing an edge are repeated on the opposite edge. -->";

export interface PatternOptions {
  /** `currentColor` (default) or a hex color. Opacity is baked into the tile. */
  readonly ink?: string;
}

const tileBody = (ink: string | undefined): string =>
  Str.replaceAll("{ink}", assertPaint(ink ?? "currentColor"))(TILE_BODY);

/** Standalone 96×96 tile SVG, identical to the committed pattern files for the same ink. */
export const t4PatternSvg = (options: PatternOptions = {}): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${PATTERN_VIEW_BOX}" width="${PATTERN_TILE_SIZE}" height="${PATTERN_TILE_SIZE}">
${TILE_COMMENT}
${tileBody(options.ink)}
</svg>
`;

export interface PatternDefOptions extends PatternOptions {
  /** `id` of the `<pattern>` element, referenced as `fill="url(#id)"`. */
  readonly id: string;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

/** `<pattern>` element (userSpaceOnUse, 96×96) for embedding in an SVG `<defs>`. */
export const t4PatternDef = (options: PatternDefOptions): string => {
  if (!ID_PATTERN.test(options.id)) {
    throw new TypeError(`Invalid pattern id "${options.id}"`);
  }
  return `<pattern id="${options.id}" patternUnits="userSpaceOnUse" width="${PATTERN_TILE_SIZE}" height="${PATTERN_TILE_SIZE}" viewBox="${PATTERN_VIEW_BOX}">
${tileBody(options.ink)}
</pattern>`;
};
