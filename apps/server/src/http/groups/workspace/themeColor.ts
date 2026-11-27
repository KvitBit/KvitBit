/**
 * Zero-dependency M3 HCT colour math, tonal palettes, hue harmonization and WCAG contrast,
 * adapted from `packages/ui-port/src/theme/color/` (ported from Google's material-color-utilities,
 * Apache-2.0) so `apps/server` resolves themes without depending on `@kvitbit/ui-port`.
 */
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

/** Opaque sRGB colour as 0xRRGGBB (no alpha channel). */
export type Rgb = number;
type Vec3 = readonly [number, number, number];

const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478],
] as const;

const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
] as const;

const WHITE_POINT_D65: Vec3 = [95.047, 100.0, 108.883];

export const clamp: {
  (hi: number, x: number): (lo: number) => number;
  (lo: number, hi: number, x: number): number;
} = Fn.dual(3, (lo: number, hi: number, x: number): number => Math.min(hi, Math.max(lo, x)));
const lerp = (a: number, b: number, t: number): number => (1 - t) * a + t * b;
const signum = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);

const sanitizeDegrees = (deg: number): number => {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
};

const differenceDegrees = (a: number, b: number): number => 180 - Math.abs(Math.abs(a - b) - 180);

const matrixMultiply = (v: Vec3, m: readonly (readonly number[])[]): Vec3 => {
  const r0 = m[0] ?? [];
  const r1 = m[1] ?? [];
  const r2 = m[2] ?? [];
  const at = (row: readonly number[], i: number) => row[i] ?? 0;
  return [
    v[0] * at(r0, 0) + v[1] * at(r0, 1) + v[2] * at(r0, 2),
    v[0] * at(r1, 0) + v[1] * at(r1, 1) + v[2] * at(r1, 2),
    v[0] * at(r2, 0) + v[1] * at(r2, 1) + v[2] * at(r2, 2),
  ];
};

const redOf = (rgb: Rgb): number => (rgb >> 16) & 0xff;
const greenOf = (rgb: Rgb): number => (rgb >> 8) & 0xff;
const blueOf = (rgb: Rgb): number => rgb & 0xff;

const rgbFromComponents = (r: number, g: number, b: number): Rgb =>
  ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);

const linearized = (channel: number): number => {
  const n = channel / 255;
  return n <= 0.040449936 ? (n / 12.92) * 100 : ((n + 0.055) / 1.055) ** 2.4 * 100;
};

const delinearized = (linear: number): number => {
  const n = linear / 100;
  const d = n <= 0.0031308 ? n * 12.92 : 1.055 * n ** (1 / 2.4) - 0.055;
  return clamp(0, 255, Math.round(d * 255));
};

const rgbFromLinrgb = (lin: Vec3): Rgb =>
  rgbFromComponents(delinearized(lin[0]), delinearized(lin[1]), delinearized(lin[2]));

const xyzFromRgb = (rgb: Rgb): Vec3 =>
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

const yFromLstar = (lstar: number): number => 100 * labInvf((lstar + 16) / 116);
const lstarFromY = (y: number): number => labF(y / 100) * 116 - 16;
const lstarFromRgb = (rgb: Rgb): number => lstarFromY(xyzFromRgb(rgb)[1]);

const rgbFromLstar = (lstar: number): Rgb => {
  const c = delinearized(yFromLstar(lstar));
  return rgbFromComponents(c, c, c);
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
export const isHex = (s: string): boolean => HEX.test(s);
export const rgbFromHex = (hex: string): Rgb =>
  Number.parseInt(Str.slice(1, 7)(hex), 16) & 0xffffff;
export const hexFromRgb = (rgb: Rgb): string =>
  `#${Str.toUpperCase(Str.padStart(6, "0")((rgb & 0xffffff).toString(16)))}`;

// --- CAM16 & HCT -------------------------------------------------------------------------------

interface ViewingConditions {
  readonly n: number;
  readonly aw: number;
  readonly nbb: number;
  readonly ncb: number;
  readonly c: number;
  readonly nc: number;
  readonly rgbD: Vec3;
  readonly fl: number;
  readonly z: number;
}

const DEFAULT_VC: ViewingConditions = (() => {
  const adaptingLuminance = ((200 / Math.PI) * yFromLstar(50)) / 100;
  const backgroundLstar = 50;
  const surround = 2;
  const [x, y, zw] = WHITE_POINT_D65;
  const rW = x * 0.401288 + y * 0.650173 + zw * -0.051461;
  const gW = x * -0.250268 + y * 1.204414 + zw * 0.045854;
  const bW = x * -0.002079 + y * 0.048952 + zw * 0.953127;
  const f = 0.8 + surround / 10;
  const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10) : lerp(0.525, 0.59, (f - 0.8) * 10);
  const d = clamp(0, 1, f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92)));
  const rgbD: Vec3 = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
  const k = 1 / (5 * adaptingLuminance + 1);
  const k4 = k * k * k * k;
  const k4F = 1 - k4;
  const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance);
  const n = yFromLstar(backgroundLstar) / y;
  const z = 1.48 + Math.sqrt(n);
  const nbb = 0.725 / n ** 0.2;
  const adapt = (v: number) => {
    const p = ((fl * v) / 100) ** 0.42;
    return (400 * p) / (p + 27.13);
  };
  const rA = adapt(rgbD[0] * rW);
  const gA = adapt(rgbD[1] * gW);
  const bA = adapt(rgbD[2] * bW);
  const aw = (2 * rA + gA + 0.05 * bA) * nbb;
  return { n, aw, nbb, ncb: nbb, c, nc: f, rgbD, fl, z };
})();

const cam16FromRgb = (rgb: Rgb) => {
  const [x, y, z] = xyzFromRgb(rgb);
  const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
  const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
  const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
  const adapt = (v: number) => {
    const p = ((DEFAULT_VC.fl * Math.abs(v)) / 100) ** 0.42;
    return (signum(v) * 400 * p) / (p + 27.13);
  };
  const rA = adapt(DEFAULT_VC.rgbD[0] * rC);
  const gA = adapt(DEFAULT_VC.rgbD[1] * gC);
  const bA = adapt(DEFAULT_VC.rgbD[2] * bC);
  const a = (11 * rA + -12 * gA + bA) / 11;
  const b = (rA + gA - 2 * bA) / 9;
  const u = (20 * rA + 20 * gA + 21 * bA) / 20;
  const p2 = (40 * rA + 20 * gA + bA) / 20;
  const hue = sanitizeDegrees((Math.atan2(b, a) * 180) / Math.PI);
  const ac = p2 * DEFAULT_VC.nbb;
  const j = 100 * (ac / DEFAULT_VC.aw) ** (DEFAULT_VC.c * DEFAULT_VC.z);
  const huePrime = hue < 20.14 ? hue + 360 : hue;
  const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8);
  const p1 = (50000 / 13) * eHue * DEFAULT_VC.nc * DEFAULT_VC.ncb;
  const t = (p1 * Math.hypot(a, b)) / (u + 0.305);
  const alpha = t ** 0.9 * (1.64 - 0.29 ** DEFAULT_VC.n) ** 0.73;
  const chroma = alpha * Math.sqrt(j / 100);
  return { hue, chroma, j };
};

const xyzFromCam16 = (j: number, chroma: number, hue: number): Vec3 => {
  const alpha = chroma === 0 || j === 0 ? 0 : chroma / Math.sqrt(j / 100);
  const t = (alpha / (1.64 - 0.29 ** DEFAULT_VC.n) ** 0.73) ** (1 / 0.9);
  const hRad = (hue * Math.PI) / 180;
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const ac = DEFAULT_VC.aw * (j / 100) ** (1 / DEFAULT_VC.c / DEFAULT_VC.z);
  const p1 = eHue * (50000 / 13) * DEFAULT_VC.nc * DEFAULT_VC.ncb;
  const p2 = ac / DEFAULT_VC.nbb;
  const hSin = Math.sin(hRad);
  const hCos = Math.cos(hRad);
  const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
  const a = gamma * hCos;
  const b = gamma * hSin;
  const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
  const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
  const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
  const unadapt = (v: number) => {
    const base = Math.max(0, (27.13 * Math.abs(v)) / (400 - Math.abs(v)));
    return signum(v) * (100 / DEFAULT_VC.fl) * base ** (1 / 0.42);
  };
  const rF = unadapt(rA) / DEFAULT_VC.rgbD[0];
  const gF = unadapt(gA) / DEFAULT_VC.rgbD[1];
  const bF = unadapt(bA) / DEFAULT_VC.rgbD[2];
  return [
    1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF,
    0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF,
    -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF,
  ];
};

const GAMUT_EPSILON = 1e-4;

const solveJ = (chroma: number, hue: number, tone: number, targetY: number): Vec3 => {
  let j = Math.sqrt(tone) * 11;
  for (let i = 0; i < 8; i++) {
    const xyz = xyzFromCam16(j, chroma, hue);
    const fnj = xyz[1];
    if (Math.abs(fnj - targetY) < 0.002) return xyz;
    if (!Number.isFinite(fnj) || fnj <= 0) break;
    j -= ((fnj - targetY) * j) / (2 * fnj);
    if (!Number.isFinite(j) || j <= 0) break;
  }
  let lo = 0;
  let hi = 200;
  let xyz: Vec3 = xyzFromCam16(hi, chroma, hue);
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    xyz = xyzFromCam16(mid, chroma, hue);
    if (xyz[1] < targetY) lo = mid;
    else hi = mid;
  }
  return xyz;
};

const linrgbInGamut = (lin: Vec3): boolean =>
  Arr.every(lin, (c) => c >= -GAMUT_EPSILON && c <= 100 + GAMUT_EPSILON);

const solveToRgb = (hue: number, chroma: number, rawTone: number): Rgb => {
  const tone = Number.isFinite(rawTone) ? clamp(0, 100, rawTone) : 0;
  if (!(chroma >= 1e-4) || tone < 1e-4 || tone > 99.9999) return rgbFromLstar(tone);
  const h = Number.isFinite(hue) ? sanitizeDegrees(hue) : 0;
  const targetY = yFromLstar(tone);
  const linAt = (c: number): Vec3 => matrixMultiply(solveJ(c, h, tone, targetY), XYZ_TO_SRGB);
  const requested = linAt(Number.isFinite(chroma) ? Math.min(chroma, 200) : 0);
  if (linrgbInGamut(requested)) return rgbFromLinrgb(requested);
  let lo = 0;
  let hi = Math.min(chroma, 200);
  let best: Vec3 | undefined;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const lin = linAt(mid);
    if (linrgbInGamut(lin)) {
      lo = mid;
      best = lin;
    } else hi = mid;
  }
  if (best !== undefined) return rgbFromLinrgb(best);
  const grey: Vec3 = [targetY, targetY, targetY];
  const mix = (t: number): Vec3 => [
    grey[0] + t * (requested[0] - grey[0]),
    grey[1] + t * (requested[1] - grey[1]),
    grey[2] + t * (requested[2] - grey[2]),
  ];
  let tLo = 0;
  let tHi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (tLo + tHi) / 2;
    if (linrgbInGamut(mix(mid))) tLo = mid;
    else tHi = mid;
  }
  return rgbFromLinrgb(mix(tLo));
};

export class Hct {
  readonly hue: number;
  readonly chroma: number;
  readonly tone: number;
  readonly rgb: Rgb;

  private constructor(hue: number, chroma: number, tone: number, rgb: Rgb) {
    this.hue = hue;
    this.chroma = chroma;
    this.tone = tone;
    this.rgb = rgb;
  }

  static fromRgb(rgb: Rgb): Hct {
    const cam = cam16FromRgb(rgb);
    return new Hct(cam.hue, cam.chroma, lstarFromRgb(rgb), rgb);
  }

  static from(hue: number, chroma: number, tone: number): Hct {
    return Hct.fromRgb(solveToRgb(hue, chroma, tone));
  }
}

export class TonalPalette {
  private readonly cache = new Map<number, Rgb>();
  readonly hue: number;
  readonly chroma: number;

  private constructor(hue: number, chroma: number) {
    this.hue = hue;
    this.chroma = chroma;
  }

  static fromHueAndChroma(hue: number, chroma: number): TonalPalette {
    return new TonalPalette(sanitizeDegrees(hue), Math.max(0, chroma));
  }

  static fromRgb(rgb: Rgb): TonalPalette {
    const hct = Hct.fromRgb(rgb);
    return new TonalPalette(hct.hue, hct.chroma);
  }

  tone(tone: number): Rgb {
    const key = Math.round(tone * 100) / 100;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const rgb = Hct.from(this.hue, this.chroma, key).rgb;
    this.cache.set(key, rgb);
    return rgb;
  }
}

const rotationDirection = (from: number, to: number): 1 | -1 =>
  sanitizeDegrees(to - from) <= 180 ? 1 : -1;

export const harmonize: {
  (source: Rgb): (design: Rgb) => Rgb;
  (design: Rgb, source: Rgb): Rgb;
} = Fn.dual(2, (design: Rgb, source: Rgb): Rgb => {
  const from = Hct.fromRgb(design);
  const to = Hct.fromRgb(source);
  const rotation = Math.min(differenceDegrees(from.hue, to.hue) * 0.5, 15);
  const hue = sanitizeDegrees(from.hue + rotation * rotationDirection(from.hue, to.hue));
  return Hct.from(hue, from.chroma, from.tone).rgb;
});

const relativeLuminance = (rgb: Rgb): number =>
  (0.2126 * linearized(redOf(rgb)) +
    0.7152 * linearized(greenOf(rgb)) +
    0.0722 * linearized(blueOf(rgb))) /
  100;

export const contrastRatio: {
  (b: Rgb): (a: Rgb) => number;
  (a: Rgb, b: Rgb): number;
} = Fn.dual(2, (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
});
