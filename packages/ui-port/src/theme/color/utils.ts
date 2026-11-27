/**
 * Colour-space helpers shared by the HCT engine: sRGB <-> linear RGB <-> XYZ, CIE L*, hex.
 * Ported from the published algorithms of Google's material-color-utilities (Apache-2.0);
 * kept zero-dependency so ui-port bundles no colour library.
 */

import * as Fn from "effect/Function";
/** Opaque sRGB colour as 0xRRGGBB (no alpha channel). */
import * as Str from "effect/String";
export type Rgb = number;

const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478],
] as const;

export const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
] as const;

export const WHITE_POINT_D65 = [95.047, 100.0, 108.883] as const;

export type Vec3 = readonly [number, number, number];

export const clamp: {
  (hi: number, x: number): (lo: number) => number;
  (lo: number, hi: number, x: number): number;
} = Fn.dual(3, (lo: number, hi: number, x: number): number => Math.min(hi, Math.max(lo, x)));

export const lerp: {
  (b: number, t: number): (a: number) => number;
  (a: number, b: number, t: number): number;
} = Fn.dual(3, (a: number, b: number, t: number): number => (1 - t) * a + t * b);

export const signum = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);

export const sanitizeDegrees = (deg: number): number => {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
};

/** Shortest angular distance between two hues, 0..180. */
export const differenceDegrees: {
  (b: number): (a: number) => number;
  (a: number, b: number): number;
} = Fn.dual(2, (a: number, b: number): number => 180 - Math.abs(Math.abs(a - b) - 180));

export const matrixMultiply: {
  (m: readonly (readonly number[])[]): (v: Vec3) => Vec3;
  (v: Vec3, m: readonly (readonly number[])[]): Vec3;
} = Fn.dual(2, (v: Vec3, m: readonly (readonly number[])[]): Vec3 => {
  const r0 = m[0] ?? [];
  const r1 = m[1] ?? [];
  const r2 = m[2] ?? [];
  const at = (row: readonly number[], i: number) => row[i] ?? 0;
  return [
    v[0] * at(r0, 0) + v[1] * at(r0, 1) + v[2] * at(r0, 2),
    v[0] * at(r1, 0) + v[1] * at(r1, 1) + v[2] * at(r1, 2),
    v[0] * at(r2, 0) + v[1] * at(r2, 1) + v[2] * at(r2, 2),
  ];
});

export const redOf = (rgb: Rgb): number => (rgb >> 16) & 0xff;
export const greenOf = (rgb: Rgb): number => (rgb >> 8) & 0xff;
export const blueOf = (rgb: Rgb): number => rgb & 0xff;

export const rgbFromComponents: {
  (g: number, b: number): (r: number) => Rgb;
  (r: number, g: number, b: number): Rgb;
} = Fn.dual(
  3,
  (r: number, g: number, b: number): Rgb => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff),
);

/** 8-bit sRGB channel to linear RGB on 0..100. */
export const linearized = (channel: number): number => {
  const n = channel / 255;
  return n <= 0.040449936 ? (n / 12.92) * 100 : ((n + 0.055) / 1.055) ** 2.4 * 100;
};

/** Linear RGB on 0..100 to a rounded, clamped 8-bit sRGB channel. */
const delinearized = (linear: number): number => {
  const n = linear / 100;
  const d = n <= 0.0031308 ? n * 12.92 : 1.055 * n ** (1 / 2.4) - 0.055;
  return clamp(0, 255, Math.round(d * 255));
};

export const rgbFromLinrgb = (lin: Vec3): Rgb =>
  rgbFromComponents(delinearized(lin[0]), delinearized(lin[1]), delinearized(lin[2]));

export const xyzFromRgb = (rgb: Rgb): Vec3 =>
  matrixMultiply(
    [linearized(redOf(rgb)), linearized(greenOf(rgb)), linearized(blueOf(rgb))],
    SRGB_TO_XYZ,
  );

const labF = (t: number): number => {
  const e = 216 / 24389;
  const k = 24389 / 27;
  return t > e ? Math.cbrt(t) : (k * t + 16) / 116;
};

const labInvf = (ft: number): number => {
  const e = 216 / 24389;
  const k = 24389 / 27;
  const ft3 = ft * ft * ft;
  return ft3 > e ? ft3 : (116 * ft - 16) / k;
};

/** CIE L* (0..100) to relative luminance Y (0..100). */
export const yFromLstar = (lstar: number): number => 100 * labInvf((lstar + 16) / 116);

/** Relative luminance Y (0..100) to CIE L* (0..100). */
export const lstarFromY = (y: number): number => labF(y / 100) * 116 - 16;

export const lstarFromRgb = (rgb: Rgb): number => lstarFromY(xyzFromRgb(rgb)[1]);

/** The grey whose L* is `lstar`. */
export const rgbFromLstar = (lstar: number): Rgb => {
  const c = delinearized(yFromLstar(lstar));
  return rgbFromComponents(c, c, c);
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

export const isHex = (s: string): boolean => HEX.test(s);

/** "#RRGGBB" (any case) to Rgb. Callers validate with `isHex` or a Hex schema first. */
export const rgbFromHex = (hex: string): Rgb =>
  Number.parseInt(Fn.pipe(hex, Str.slice(1, 7)), 16) & 0xffffff;

/** Rgb to upper-case "#RRGGBB". */
export const hexFromRgb = (rgb: Rgb): string =>
  `#${Str.toUpperCase(Fn.pipe((rgb & 0xffffff).toString(16), Str.padStart(6, "0")))}`;

/** CIELAB (D65) of an sRGB colour: L* 0..100, a*, b*. sRGB greys have a* = b* = 0. */
export const labFromRgb = (rgb: Rgb): Vec3 => {
  const [x, y, z] = xyzFromRgb(rgb);
  const fx = labF(x / WHITE_POINT_D65[0]);
  const fy = labF(y / WHITE_POINT_D65[1]);
  const fz = labF(z / WHITE_POINT_D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
