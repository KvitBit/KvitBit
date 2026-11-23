import { describe, expect, test } from "bun:test";
import {
  cam16FromRgb,
  contrastRatio,
  Hct,
  harmonize,
  hexFromRgb,
  lstarFromRgb,
  rgbFromHex,
  TonalPalette,
} from "../../src/theme";

const channels = (hex: string) => {
  const n = rgbFromHex(hex);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
/** Max per-channel distance between two hex colours. */
const distance = (a: string, b: string) => {
  const [x, y] = [channels(a), channels(b)];
  return Math.max(...x.map((v, i) => Math.abs(v - (y[i] ?? 0))));
};

describe("CAM16 / HCT against material-color-utilities reference values", () => {
  // material-color-utilities cam16 / hct unit tests.
  test.each([
    [0xff0000, 27.408, 113.357, 46.445, 53.233],
    [0x00ff00, 142.139, 108.41, 79.332, 87.737],
    [0x0000ff, 282.788, 87.23, 25.466, 32.302],
    [0xffffff, 209.492, 2.869, 100, 100],
  ])("%x", (rgb, hue, chroma, j, tone) => {
    const cam = cam16FromRgb(rgb);
    expect(cam.hue).toBeCloseTo(hue, 2);
    expect(cam.chroma).toBeCloseTo(chroma, 2);
    expect(cam.j).toBeCloseTo(j, 2);
    expect(lstarFromRgb(rgb)).toBeCloseTo(tone, 2);
  });

  test("black has zero chroma and tone", () => {
    const hct = Hct.fromRgb(0x000000);
    expect(hct.chroma).toBeCloseTo(0, 5);
    expect(hct.tone).toBeCloseTo(0, 5);
  });

  test.each([
    "#6750A4",
    "#0F5D42",
    "#1D4ED8",
    "#6B2D5C",
    "#C2410C",
    "#FFD600",
    "#7FFFD4",
    "#111111",
  ])("round-trips %s through HCT", (hex) => {
    const hct = Hct.fromRgb(rgbFromHex(hex));
    expect(
      distance(hexFromRgb(Hct.from(hct.hue, hct.chroma, hct.tone).rgb), hex),
    ).toBeLessThanOrEqual(1);
  });

  test("solved colours keep the requested tone, and chroma when in gamut", () => {
    for (const [h, c, t] of [
      [30, 40, 50],
      [140, 30, 70],
      [260, 40, 30],
      [320, 20, 90],
    ] as const) {
      const hct = Hct.from(h, c, t);
      expect(hct.tone).toBeCloseTo(t, 0);
      expect(Math.abs(hct.hue - h)).toBeLessThan(1.5);
      expect(Math.abs(hct.chroma - c)).toBeLessThan(1.5);
    }
  });

  test("out-of-gamut chroma is reduced, never the tone", () => {
    const hct = Hct.from(120, 200, 50);
    expect(hct.chroma).toBeLessThan(200);
    expect(hct.tone).toBeCloseTo(50, 0);
  });
});

describe("TonalPalette reproduces the Material 3 baseline (seed #6750A4)", () => {
  // Published M3 baseline tonal palettes (CorePalette: primary chroma max(48, c), n1 4, n2 8,
  // secondary 16, tertiary hue + 60 at 24), within one 8-bit step.
  const seed = Hct.fromRgb(0x6750a4);
  const primary = TonalPalette.fromHueAndChroma(seed.hue, Math.max(48, seed.chroma));
  const neutral = TonalPalette.fromHueAndChroma(seed.hue, 4);
  const neutralVariant = TonalPalette.fromHueAndChroma(seed.hue, 8);
  const secondary = TonalPalette.fromHueAndChroma(seed.hue, 16);
  const tertiary = TonalPalette.fromHueAndChroma(seed.hue + 60, 24);
  test.each([
    [primary, 40, "#6750A4"],
    [primary, 80, "#D0BCFF"],
    [primary, 90, "#EADDFF"],
    [primary, 10, "#21005D"],
    [primary, 100, "#FFFFFF"],
    [neutral, 10, "#1C1B1F"],
    [neutral, 90, "#E6E1E5"],
    [neutral, 99, "#FFFBFE"],
    [neutralVariant, 30, "#49454F"],
    [neutralVariant, 50, "#79747E"],
    [neutralVariant, 80, "#CAC4D0"],
    [secondary, 40, "#625B71"],
    [tertiary, 40, "#7D5260"],
  ] as const)("%#: tone %d ~ %s", (palette, tone, hex) => {
    expect(distance(hexFromRgb(palette.tone(tone)), hex)).toBeLessThanOrEqual(1);
  });
});

describe("harmonize", () => {
  test("rotates toward the source hue by at most 15 degrees, keeping tone", () => {
    const red = Hct.fromRgb(0xc2410c);
    const towardBlue = Hct.fromRgb(harmonize(0xc2410c, 0x1d4ed8));
    const rotation = Math.abs(towardBlue.hue - red.hue);
    expect(rotation).toBeGreaterThan(5);
    expect(rotation).toBeLessThanOrEqual(15.5);
    expect(towardBlue.tone).toBeCloseTo(red.tone, 0);
  });

  test("halves small differences", () => {
    const a = Hct.from(100, 40, 50);
    const b = Hct.from(110, 40, 50);
    expect(Hct.fromRgb(harmonize(a.rgb, b.rgb)).hue).toBeCloseTo(105, 0);
  });
});

describe("WCAG contrast", () => {
  test("black on white is 21:1 and symmetric", () => {
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 5);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
    expect(contrastRatio(0x777777, 0x777777)).toBeCloseTo(1, 5);
  });

  test("#767676 on white is the classic 4.54:1", () => {
    expect(contrastRatio(0x767676, 0xffffff)).toBeCloseTo(4.54, 2);
  });
});
