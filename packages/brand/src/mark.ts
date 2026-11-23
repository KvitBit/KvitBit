import { assertPaint, escapeXmlText } from "./svg";
import { brandColors } from "./tokens";

/** N2 Dual-Bit Notch mark grid: 256×256 with 32 units of built-in padding. */
export const MARK_VIEW_BOX = "0 0 256 256" as const;
export const MARK_GRID_SIZE = 256 as const;

export type MarkMaster = "light" | "dark";

export interface MarkMasterGeometry {
  /** Gap in grid units between the stem, chevron and bit. */
  readonly gap: number;
  /** Path data in draw order: notched stem, `<` chevron, square bit. */
  readonly paths: readonly [stem: string, chevron: string, bit: string];
}

/**
 * The two optical masters, copied verbatim from `assets/brand/kvitbit-mark-{light,dark}.svg`.
 * `light`: dark ink on light surfaces, 10-unit gap. `dark`: light ink on dark surfaces, 14-unit gap
 * (light ink bleeds into gaps, so they are widened).
 */
export const markMasters: Readonly<Record<MarkMaster, MarkMasterGeometry>> = {
  light: {
    gap: 10,
    paths: [
      "M27 32 H75 V106 H51 V150 H75 V224 H27 Z",
      "M85 128 L181 32 H229 L133 128 L229 224 H181 Z",
      "M185 106 H229 V150 H185 Z",
    ],
  },
  dark: {
    gap: 14,
    paths: [
      "M25 32 H73 V106 H49 V150 H73 V224 H25 Z",
      "M87 128 L183 32 H231 L135 128 L231 224 H183 Z",
      "M187 106 H231 V150 H187 Z",
    ],
  },
};

/** Default ink per master: `#111111` for the light master, `#FAFAFA` for the dark master. */
export const markDefaultFill: Readonly<Record<MarkMaster, string>> = {
  light: brandColors.inkOnLight,
  dark: brandColors.inkOnDark,
};

export interface MarkSvgOptions {
  readonly master: MarkMaster;
  /** `currentColor` or a hex color. Defaults to the master's brand ink. */
  readonly fill?: string;
  /** Pixel width/height attributes. Defaults to 256. */
  readonly size?: number;
  readonly title?: string;
}

/** Standalone mark SVG in the same shape as the committed `kvitbit-mark-*.svg` files. */
export const markSvg = (options: MarkSvgOptions): string => {
  const fill = assertPaint(options.fill ?? markDefaultFill[options.master]);
  const size = options.size ?? MARK_GRID_SIZE;
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError(`Invalid mark size ${size}: expected a positive number`);
  }
  const title = escapeXmlText(options.title ?? "Kvitbit");
  const paths = markMasters[options.master].paths.map((d) => `    <path d="${d}"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEW_BOX}" width="${size}" height="${size}" role="img" aria-labelledby="title">
  <title id="title">${title}</title>
  <g fill="${fill}">
${paths}
  </g>
</svg>
`;
};
