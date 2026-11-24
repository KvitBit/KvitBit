/**
 * CAM16 and HCT (hue, chroma, tone), following material-color-utilities: hue and chroma come
 * from CAM16 under default viewing conditions, tone is CIE L*. `Hct.from` solves the inverse:
 * the sRGB colour with the requested hue and tone and the largest in-gamut chroma at or below
 * the requested chroma.
 */
import {
  clamp,
  lerp,
  lstarFromRgb,
  matrixMultiply,
  type Rgb,
  rgbFromLinrgb,
  rgbFromLstar,
  sanitizeDegrees,
  signum,
  type Vec3,
  WHITE_POINT_D65,
  XYZ_TO_SRGB,
  xyzFromRgb,
  yFromLstar,
} from "./utils";

export interface ViewingConditions {
  readonly n: number;
  readonly aw: number;
  readonly nbb: number;
  readonly ncb: number;
  readonly c: number;
  readonly nc: number;
  readonly rgbD: Vec3;
  readonly fl: number;
  readonly fLRoot: number;
  readonly z: number;
}

const makeViewingConditions = (
  whitePoint: Vec3 = WHITE_POINT_D65,
  adaptingLuminance = ((200 / Math.PI) * yFromLstar(50)) / 100,
  backgroundLstar = 50,
  surround = 2,
  discountingIlluminant = false,
): ViewingConditions => {
  const [x, y, zw] = whitePoint;
  const rW = x * 0.401288 + y * 0.650173 + zw * -0.051461;
  const gW = x * -0.250268 + y * 1.204414 + zw * 0.045854;
  const bW = x * -0.002079 + y * 0.048952 + zw * 0.953127;
  const f = 0.8 + surround / 10;
  const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10) : lerp(0.525, 0.59, (f - 0.8) * 10);
  const d = clamp(
    0,
    1,
    discountingIlluminant ? 1 : f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92)),
  );
  const rgbD: Vec3 = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
  const k = 1 / (5 * adaptingLuminance + 1);
  const k4 = k * k * k * k;
  const k4F = 1 - k4;
  const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance);
  const n = yFromLstar(backgroundLstar) / whitePoint[1];
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
  return { n, aw, nbb, ncb: nbb, c, nc: f, rgbD, fl, fLRoot: fl ** 0.25, z };
};

export const DEFAULT_VIEWING_CONDITIONS: ViewingConditions = makeViewingConditions();

export interface Cam16 {
  readonly hue: number;
  readonly chroma: number;
  readonly j: number;
}

export const cam16FromXyz = (xyz: Vec3, vc: ViewingConditions = DEFAULT_VIEWING_CONDITIONS) => {
  const [x, y, z] = xyz;
  const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
  const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
  const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
  const adapt = (v: number) => {
    const p = ((vc.fl * Math.abs(v)) / 100) ** 0.42;
    return (signum(v) * 400 * p) / (p + 27.13);
  };
  const rA = adapt(vc.rgbD[0] * rC);
  const gA = adapt(vc.rgbD[1] * gC);
  const bA = adapt(vc.rgbD[2] * bC);
  const a = (11 * rA + -12 * gA + bA) / 11;
  const b = (rA + gA - 2 * bA) / 9;
  const u = (20 * rA + 20 * gA + 21 * bA) / 20;
  const p2 = (40 * rA + 20 * gA + bA) / 20;
  const hue = sanitizeDegrees((Math.atan2(b, a) * 180) / Math.PI);
  const ac = p2 * vc.nbb;
  const j = 100 * (ac / vc.aw) ** (vc.c * vc.z);
  const huePrime = hue < 20.14 ? hue + 360 : hue;
  const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8);
  const p1 = (50000 / 13) * eHue * vc.nc * vc.ncb;
  const t = (p1 * Math.hypot(a, b)) / (u + 0.305);
  const alpha = t ** 0.9 * (1.64 - 0.29 ** vc.n) ** 0.73;
  const chroma = alpha * Math.sqrt(j / 100);
  return { hue, chroma, j } satisfies Cam16;
};

export const cam16FromRgb = (rgb: Rgb): Cam16 => cam16FromXyz(xyzFromRgb(rgb));

/** CAM16 (J, C, h) to XYZ under `vc`. */
export const xyzFromCam16 = (
  j: number,
  chroma: number,
  hue: number,
  vc: ViewingConditions = DEFAULT_VIEWING_CONDITIONS,
): Vec3 => {
  const alpha = chroma === 0 || j === 0 ? 0 : chroma / Math.sqrt(j / 100);
  const t = (alpha / (1.64 - 0.29 ** vc.n) ** 0.73) ** (1 / 0.9);
  const hRad = (hue * Math.PI) / 180;
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const ac = vc.aw * (j / 100) ** (1 / vc.c / vc.z);
  const p1 = eHue * (50000 / 13) * vc.nc * vc.ncb;
  const p2 = ac / vc.nbb;
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
    return signum(v) * (100 / vc.fl) * base ** (1 / 0.42);
  };
  const rF = unadapt(rA) / vc.rgbD[0];
  const gF = unadapt(gA) / vc.rgbD[1];
  const bF = unadapt(bA) / vc.rgbD[2];
  return [
    1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF,
    0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF,
    -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF,
  ];
};

const GAMUT_EPSILON = 1e-4;

/**
 * For fixed C and h, find the J whose luminance is `targetY`. Newton's method from mcu's
 * `findResultByJ` (Y grows roughly with J squared), with bisection as a fallback.
 */
const solveJ = (chroma: number, hue: number, tone: number, targetY: number): Vec3 => {
  let j = Math.sqrt(tone) * 11;
  for (let i = 0; i < 8; i++) {
    const xyz = xyzFromCam16(j, chroma, hue);
    const fnj = xyz[1];
    if (Math.abs(fnj - targetY) < 0.002) return xyz;
    if (!(fnj > 0) || !Number.isFinite(fnj)) break;
    j = j - ((fnj - targetY) * j) / (2 * fnj);
    if (!(j > 0) || !Number.isFinite(j)) break;
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
  lin.every((c) => c >= -GAMUT_EPSILON && c <= 100 + GAMUT_EPSILON);

/** The sRGB colour with `hue` and `tone` and the largest in-gamut chroma at or below `chroma`. */
export const solveToRgb = (hue: number, chroma: number, rawTone: number): Rgb => {
  // Non-finite input never reaches the solver: NaN tone is black, NaN hue is 0, NaN chroma grey.
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
  // Near black and white even CAM16 chroma 0 can sit outside sRGB (CAM16's neutral axis is not
  // sRGB grey). Clip toward the grey of the same luminance instead, as mcu's bisectToLimit does:
  // linear mixing keeps Y, so the tone stays exact while the hue stays close.
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

/** A colour in HCT. Immutable; construct with `Hct.fromRgb` or `Hct.from`. */
export class Hct {
  private constructor(
    readonly hue: number,
    readonly chroma: number,
    readonly tone: number,
    readonly rgb: Rgb,
  ) {}

  static fromRgb(rgb: Rgb): Hct {
    const cam = cam16FromRgb(rgb);
    return new Hct(cam.hue, cam.chroma, lstarFromRgb(rgb), rgb);
  }

  /** Nearest displayable colour; its chroma may be lower than requested (gamut-mapped). */
  static from(hue: number, chroma: number, tone: number): Hct {
    return Hct.fromRgb(solveToRgb(hue, chroma, tone));
  }

  withTone(tone: number): Hct {
    return Hct.from(this.hue, this.chroma, tone);
  }
}
