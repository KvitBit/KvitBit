import { escapeXmlText } from "./svg";
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
 * Geometry A1: chevron arms at 34.5° from vertical (66:96), matching the Clash Display `K`.
 * `light`: dark ink on light surfaces, 10-unit gap. `dark`: light ink on dark surfaces, 14-unit gap
 * (light ink bleeds into gaps, so they are widened).
 */
export const markMasters: Readonly<Record<MarkMaster, MarkMasterGeometry>> = {
  light: {
    gap: 10,
    paths: [
      "M36 32 H84 V106 H60 V150 H84 V224 H36 Z",
      "M94 128 L160 32 H208 L142 128 L208 224 H160 Z",
      "M176 106 H220 V150 H176 Z",
    ],
  },
  dark: {
    gap: 14,
    paths: [
      "M34 32 H82 V106 H58 V150 H82 V224 H34 Z",
      "M96 128 L162 32 H210 L144 128 L210 224 H162 Z",
      "M178 106 H222 V150 H178 Z",
    ],
  },
};

/** Default ink per master: `#111111` for the light master, `#FAFAFA` for the dark master. */
export const markDefaultFill: Readonly<Record<MarkMaster, string>> = {
  light: brandColors.inkOnLight,
  dark: brandColors.inkOnDark,
};

/**
 * Inks each master ships in (DESIGN.md: never recolour the mark). `currentColor` inherits the
 * surrounding text color for inline use.
 */
export const markFills = {
  light: [brandColors.inkOnLight, brandColors.black, "currentColor"],
  dark: [brandColors.inkOnDark, brandColors.white, "currentColor"],
} as const satisfies Record<MarkMaster, readonly string[]>;

export type MarkFill<M extends MarkMaster = MarkMaster> = (typeof markFills)[M][number];

interface MarkSvgCommonOptions {
  /** Pixel width/height attributes. Defaults to 256. */
  readonly size?: number;
  readonly title?: string;
}

export type MarkSvgOptions = {
  [M in MarkMaster]: MarkSvgCommonOptions & {
    readonly master: M;
    /** One of the master's shipped inks. Defaults to the master's brand ink. */
    readonly fill?: MarkFill<M>;
  };
}[MarkMaster];

/** Standalone mark SVG in the same shape as the committed `kvitbit-mark-*.svg` files. */
export const markSvg = (options: MarkSvgOptions): string => {
  const fill = options.fill ?? markDefaultFill[options.master];
  const allowed: readonly string[] = markFills[options.master];
  if (!allowed.includes(fill)) {
    throw new TypeError(
      `Invalid fill "${fill}" for the ${options.master} master: expected one of ${allowed.join(", ")}`,
    );
  }
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
