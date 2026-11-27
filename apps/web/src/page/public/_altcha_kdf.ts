import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Pure-TS cryptographic primitives for ALTCHA PoW v2 (SHA-256, PBKDF2/SHA-256, BLAKE2b, Argon2id).
 * Matches `altcha-lib` server verification (ARGON2ID, PBKDF2/SHA-256, SHA-256).
 * Private to src/page/public/.
 */

// biome-ignore lint/security/noSecrets: This alphabet is defined by the encoding.
const HEX = "0123456789abcdef";

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) {
    out += (HEX[b >>> 4] ?? "") + (HEX[b & 0x0f] ?? "");
  }
  return out;
};

export const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || !hexText.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(Str.slice(i * 2, i * 2 + 2)(hex), 16);
  }
  return out;
};

// biome-ignore lint/security/noSecrets: This alphabet is defined by the encoding.
const B64_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_ALPHA[(n >>> 18) & 63];
    out += B64_ALPHA[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHA[(n >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_ALPHA[n & 63] : "=";
  }
  return out;
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr32 = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export const sha256 = (data: Uint8Array): Uint8Array => {
  const bitLen = data.length * 8;
  const padLen = ((data.length + 9 + 63) >>> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(data, 0);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
};

const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  const blockKey = new Uint8Array(64);
  blockKey.set(key.length > 64 ? sha256(key) : key, 0);
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = (blockKey[i] ?? 0) ^ 0x36;
    outer[i] = (blockKey[i] ?? 0) ^ 0x5c;
  }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
};

const pbkdf2Fallback = (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number,
): Uint8Array => {
  const blocks = Math.ceil(keyLength / 32);
  const out = new Uint8Array(blocks * 32);
  const saltBlock = new Uint8Array(salt.length + 4);
  saltBlock.set(salt, 0);
  const saltView = new DataView(saltBlock.buffer);
  for (let block = 1; block <= blocks; block++) {
    saltView.setUint32(salt.length, block, false);
    let u = hmacSha256(password, saltBlock);
    const t = new Uint8Array(u);
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(password, u);
      for (let j = 0; j < 32; j++) t[j] = (t[j] ?? 0) ^ (u[j] ?? 0);
    }
    out.set(t, (block - 1) * 32);
  }
  return out.subarray(0, keyLength);
};

class Pbkdf2Error extends Schema.TaggedError<Pbkdf2Error, { readonly brand: unique symbol }>()(
  "Pbkdf2Error",
  {},
) {}

export const pbkdf2Sha256 = Effect.fn("pbkdf2Sha256")(function* (options: {
  readonly password: Uint8Array;
  readonly salt: Uint8Array;
  readonly iterations: number;
  readonly keyLength: number;
}) {
  const { password, salt, iterations, keyLength } = options;
  const fallback = () => pbkdf2Fallback(password, salt, iterations, keyLength);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return fallback();
  const derive = Effect.gen(function* () {
    const baseKey = yield* Effect.tryPromise({
      try: () =>
        subtle.importKey("raw", Uint8Array.from(password), "PBKDF2", false, ["deriveBits"]),
      catch: () => Pbkdf2Error.make({}),
    });
    const bits = yield* Effect.tryPromise({
      try: () =>
        subtle.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations },
          baseKey,
          keyLength * 8,
        ),
      catch: () => Pbkdf2Error.make({}),
    });
    return new Uint8Array(bits);
  });
  return yield* Effect.orElseSucceed(derive, fallback);
});

const BLAKE2B_IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const BLAKE2B_SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11,
  7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6,
  5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8,
  3, 4, 13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14,
  12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10,
  2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
]);

const b2bAdd = (v: Uint32Array, a: number, b: number, cLo: number, cHi: number): void => {
  let lo = (v[a] ?? 0) + (v[b] ?? 0);
  let hi = (v[a + 1] ?? 0) + (v[b + 1] ?? 0) + (lo > 0xffffffff ? 1 : 0);
  lo >>>= 0;
  lo += cLo;
  hi += cHi + (lo > 0xffffffff ? 1 : 0);
  v[a] = lo >>> 0;
  v[a + 1] = hi >>> 0;
};

const b2bG = (
  v: Uint32Array,
  m: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  ix: number,
  iy: number,
): void => {
  b2bAdd(v, a, b, m[ix] ?? 0, m[ix + 1] ?? 0);
  let xLo = (v[d] ?? 0) ^ (v[a] ?? 0);
  let xHi = (v[d + 1] ?? 0) ^ (v[a + 1] ?? 0);
  v[d] = xHi;
  v[d + 1] = xLo;

  b2bAdd(v, c, d, 0, 0);
  xLo = (v[b] ?? 0) ^ (v[c] ?? 0);
  xHi = (v[b + 1] ?? 0) ^ (v[c + 1] ?? 0);
  v[b] = ((xLo >>> 24) | (xHi << 8)) >>> 0;
  v[b + 1] = ((xHi >>> 24) | (xLo << 8)) >>> 0;

  b2bAdd(v, a, b, m[iy] ?? 0, m[iy + 1] ?? 0);
  xLo = (v[d] ?? 0) ^ (v[a] ?? 0);
  xHi = (v[d + 1] ?? 0) ^ (v[a + 1] ?? 0);
  v[d] = ((xLo >>> 16) | (xHi << 16)) >>> 0;
  v[d + 1] = ((xHi >>> 16) | (xLo << 16)) >>> 0;

  b2bAdd(v, c, d, 0, 0);
  xLo = (v[b] ?? 0) ^ (v[c] ?? 0);
  xHi = (v[b + 1] ?? 0) ^ (v[c + 1] ?? 0);
  v[b] = ((xLo << 1) | (xHi >>> 31)) >>> 0;
  v[b + 1] = ((xHi << 1) | (xLo >>> 31)) >>> 0;
};

const blake2b = (input: Uint8Array, outLen: number): Uint8Array => {
  const h = new Uint32Array(BLAKE2B_IV);
  h[0] = (h[0] ?? 0) ^ (0x01010000 ^ outLen);
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  const block = new Uint8Array(128);
  const blockView = new DataView(block.buffer);

  const compress = (bytesRead: number, isLast: boolean) => {
    for (let i = 0; i < 16; i++) v[i] = h[i] ?? 0;
    for (let i = 0; i < 16; i++) v[16 + i] = BLAKE2B_IV[i] ?? 0;
    v[24] = (v[24] ?? 0) ^ (bytesRead >>> 0);
    v[25] = (v[25] ?? 0) ^ (Math.floor(bytesRead / 0x100000000) >>> 0);
    if (isLast) {
      v[28] = (v[28] ?? 0) ^ 0xffffffff;
      v[29] = (v[29] ?? 0) ^ 0xffffffff;
    }
    for (let i = 0; i < 32; i++) m[i] = blockView.getUint32(i * 4, true);
    for (let r = 0; r < 12; r++) {
      const s = r * 16;
      b2bG(v, m, 0, 8, 16, 24, (BLAKE2B_SIGMA[s] ?? 0) * 2, (BLAKE2B_SIGMA[s + 1] ?? 0) * 2);
      b2bG(v, m, 2, 10, 18, 26, (BLAKE2B_SIGMA[s + 2] ?? 0) * 2, (BLAKE2B_SIGMA[s + 3] ?? 0) * 2);
      b2bG(v, m, 4, 12, 20, 28, (BLAKE2B_SIGMA[s + 4] ?? 0) * 2, (BLAKE2B_SIGMA[s + 5] ?? 0) * 2);
      b2bG(v, m, 6, 14, 22, 30, (BLAKE2B_SIGMA[s + 6] ?? 0) * 2, (BLAKE2B_SIGMA[s + 7] ?? 0) * 2);
      b2bG(v, m, 0, 10, 20, 30, (BLAKE2B_SIGMA[s + 8] ?? 0) * 2, (BLAKE2B_SIGMA[s + 9] ?? 0) * 2);
      b2bG(v, m, 2, 12, 22, 24, (BLAKE2B_SIGMA[s + 10] ?? 0) * 2, (BLAKE2B_SIGMA[s + 11] ?? 0) * 2);
      b2bG(v, m, 4, 14, 16, 26, (BLAKE2B_SIGMA[s + 12] ?? 0) * 2, (BLAKE2B_SIGMA[s + 13] ?? 0) * 2);
      b2bG(v, m, 6, 8, 18, 28, (BLAKE2B_SIGMA[s + 14] ?? 0) * 2, (BLAKE2B_SIGMA[s + 15] ?? 0) * 2);
    }
    for (let i = 0; i < 16; i++) h[i] = (h[i] ?? 0) ^ ((v[i] ?? 0) ^ (v[i + 16] ?? 0));
  };

  let offset = 0;
  while (input.length - offset > 128) {
    block.set(input.subarray(offset, offset + 128), 0);
    offset += 128;
    compress(offset, false);
  }
  block.fill(0);
  block.set(input.subarray(offset), 0);
  compress(input.length, true);

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) outView.setUint32(i * 4, h[i] ?? 0, true);
  return out.subarray(0, outLen);
};

const ARGON2_VERSION = 0x13;
const ARGON2_TYPE_ID = 2;
const ARGON2_SYNC_POINTS = 4;
const BLOCK_U32 = 256;

const blake2bLong = (input: Uint8Array, outLen: number): Uint8Array => {
  const prefixed = new Uint8Array(4 + input.length);
  new DataView(prefixed.buffer).setUint32(0, outLen, true);
  prefixed.set(input, 4);
  if (outLen <= 64) return blake2b(prefixed, outLen);
  const out = new Uint8Array(outLen);
  let v = blake2b(prefixed, 64);
  out.set(v.subarray(0, 32), 0);
  let pos = 32;
  while (outLen - pos > 64) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), pos);
    pos += 32;
  }
  out.set(blake2b(v, outLen - pos), pos);
  return out;
};

const argonAddMul = (w: Uint32Array, a: number, b: number): void => {
  const aLo = w[a] ?? 0;
  const aHi = w[a + 1] ?? 0;
  const bLo = w[b] ?? 0;
  const bHi = w[b + 1] ?? 0;
  const a0 = aLo & 0xffff;
  const a1 = aLo >>> 16;
  const b0 = bLo & 0xffff;
  const b1 = bLo >>> 16;
  const p0 = a0 * b0;
  const p1 = a0 * b1 + a1 * b0;
  const p2 = a1 * b1;
  const lowSum = p0 + (p1 & 0xffff) * 0x10000;
  let mulLo = lowSum >>> 0;
  let mulHi = (p2 + Math.floor(p1 / 0x10000) + Math.floor(lowSum / 0x100000000)) >>> 0;
  mulHi = ((mulHi << 1) | (mulLo >>> 31)) >>> 0;
  mulLo = (mulLo << 1) >>> 0;

  let lo = aLo + bLo;
  let hi = aHi + bHi + (lo > 0xffffffff ? 1 : 0);
  lo = (lo >>> 0) + mulLo;
  hi = hi + mulHi + (lo > 0xffffffff ? 1 : 0);
  w[a] = lo >>> 0;
  w[a + 1] = hi >>> 0;
};

const argonGB = (w: Uint32Array, a: number, b: number, c: number, d: number): void => {
  argonAddMul(w, a, b);
  let xLo = (w[d] ?? 0) ^ (w[a] ?? 0);
  let xHi = (w[d + 1] ?? 0) ^ (w[a + 1] ?? 0);
  w[d] = xHi;
  w[d + 1] = xLo;

  argonAddMul(w, c, d);
  xLo = (w[b] ?? 0) ^ (w[c] ?? 0);
  xHi = (w[b + 1] ?? 0) ^ (w[c + 1] ?? 0);
  w[b] = ((xLo >>> 24) | (xHi << 8)) >>> 0;
  w[b + 1] = ((xHi >>> 24) | (xLo << 8)) >>> 0;

  argonAddMul(w, a, b);
  xLo = (w[d] ?? 0) ^ (w[a] ?? 0);
  xHi = (w[d + 1] ?? 0) ^ (w[a + 1] ?? 0);
  w[d] = ((xLo >>> 16) | (xHi << 16)) >>> 0;
  w[d + 1] = ((xHi >>> 16) | (xLo << 16)) >>> 0;

  argonAddMul(w, c, d);
  xLo = (w[b] ?? 0) ^ (w[c] ?? 0);
  xHi = (w[b + 1] ?? 0) ^ (w[c + 1] ?? 0);
  w[b] = ((xLo << 1) | (xHi >>> 31)) >>> 0;
  w[b + 1] = ((xHi << 1) | (xLo >>> 31)) >>> 0;
};

const permute16 = (
  w: Uint32Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
  i4: number,
  i5: number,
  i6: number,
  i7: number,
  i8: number,
  i9: number,
  i10: number,
  i11: number,
  i12: number,
  i13: number,
  i14: number,
  i15: number,
): void => {
  argonGB(w, i0, i4, i8, i12);
  argonGB(w, i1, i5, i9, i13);
  argonGB(w, i2, i6, i10, i14);
  argonGB(w, i3, i7, i11, i15);
  argonGB(w, i0, i5, i10, i15);
  argonGB(w, i1, i6, i11, i12);
  argonGB(w, i2, i7, i8, i13);
  argonGB(w, i3, i4, i9, i14);
};

const fillBlock = (
  prev: Uint32Array,
  prevOff: number,
  ref: Uint32Array,
  refOff: number,
  next: Uint32Array,
  nextOff: number,
  xorIntoNext: boolean,
  tmpR: Uint32Array,
  tmpZ: Uint32Array,
): void => {
  for (let i = 0; i < BLOCK_U32; i++) {
    const r = (prev[prevOff + i] ?? 0) ^ (ref[refOff + i] ?? 0);
    tmpR[i] = r;
    tmpZ[i] = r;
  }
  for (let r = 0; r < 8; r++) {
    const b = r * 32;
    permute16(
      tmpZ,
      b,
      b + 2,
      b + 4,
      b + 6,
      b + 8,
      b + 10,
      b + 12,
      b + 14,
      b + 16,
      b + 18,
      b + 20,
      b + 22,
      b + 24,
      b + 26,
      b + 28,
      b + 30,
    );
  }
  for (let c = 0; c < 8; c++) {
    const b = c * 4;
    permute16(
      tmpZ,
      b,
      b + 2,
      b + 32,
      b + 34,
      b + 64,
      b + 66,
      b + 96,
      b + 98,
      b + 128,
      b + 130,
      b + 160,
      b + 162,
      b + 192,
      b + 194,
      b + 224,
      b + 226,
    );
  }
  if (xorIntoNext) {
    for (let i = 0; i < BLOCK_U32; i++)
      next[nextOff + i] = (next[nextOff + i] ?? 0) ^ ((tmpR[i] ?? 0) ^ (tmpZ[i] ?? 0));
  } else {
    for (let i = 0; i < BLOCK_U32; i++) next[nextOff + i] = (tmpR[i] ?? 0) ^ (tmpZ[i] ?? 0);
  }
};

export interface Argon2idParams {
  readonly memoryCost: number;
  readonly cost: number;
  readonly parallelism: number;
  readonly keyLength: number;
}

const argon2idImpl = (
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
): Uint8Array => {
  const p = Math.max(1, params.parallelism);
  const t = Math.max(1, params.cost);
  const tagLen = Math.max(4, params.keyLength);
  const m = Math.max(8 * p, params.memoryCost);

  const h0Input = new Uint8Array(40 + password.length + salt.length);
  const h0View = new DataView(h0Input.buffer);
  let pos = 0;
  h0View.setUint32(pos, p, true);
  pos += 4;
  h0View.setUint32(pos, tagLen, true);
  pos += 4;
  h0View.setUint32(pos, m, true);
  pos += 4;
  h0View.setUint32(pos, t, true);
  pos += 4;
  h0View.setUint32(pos, ARGON2_VERSION, true);
  pos += 4;
  h0View.setUint32(pos, ARGON2_TYPE_ID, true);
  pos += 4;
  h0View.setUint32(pos, password.length, true);
  pos += 4;
  h0Input.set(password, pos);
  pos += password.length;
  h0View.setUint32(pos, salt.length, true);
  pos += 4;
  h0Input.set(salt, pos);
  pos += salt.length;
  h0View.setUint32(pos, 0, true);
  pos += 4;
  h0View.setUint32(pos, 0, true);

  const h0 = blake2b(h0Input, 64);

  const segmentLength = Math.floor(m / (p * ARGON2_SYNC_POINTS));
  const laneLength = segmentLength * ARGON2_SYNC_POINTS;
  const totalBlocks = laneLength * p;
  const mem = new Uint32Array(totalBlocks * BLOCK_U32);
  const seedBuf = new Uint8Array(72);
  seedBuf.set(h0, 0);
  const seedView = new DataView(seedBuf.buffer);

  const writeBytesToBlock = (bytes: Uint8Array, blockIndex: number) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = blockIndex * BLOCK_U32;
    for (let i = 0; i < BLOCK_U32; i++) mem[base + i] = view.getUint32(i * 4, true);
  };

  for (let lane = 0; lane < p; lane++) {
    seedView.setUint32(64, 0, true);
    seedView.setUint32(68, lane, true);
    writeBytesToBlock(blake2bLong(seedBuf, 1024), lane * laneLength);

    seedView.setUint32(64, 1, true);
    seedView.setUint32(68, lane, true);
    writeBytesToBlock(blake2bLong(seedBuf, 1024), lane * laneLength + 1);
  }

  const zeroBlock = new Uint32Array(BLOCK_U32);
  const inputBlock = new Uint32Array(BLOCK_U32);
  const addrBlock = new Uint32Array(BLOCK_U32);
  const tmpR = new Uint32Array(BLOCK_U32);
  const tmpZ = new Uint32Array(BLOCK_U32);

  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < ARGON2_SYNC_POINTS; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const dataIndependent = pass === 0 && slice < 2;
        let addrCounter = 0;
        if (dataIndependent) {
          inputBlock.fill(0);
          inputBlock[0] = pass;
          inputBlock[2] = lane;
          inputBlock[4] = slice;
          inputBlock[6] = totalBlocks;
          inputBlock[8] = t;
          inputBlock[10] = ARGON2_TYPE_ID;
        }
        const startIdx = pass === 0 && slice === 0 ? 2 : 0;
        for (let idx = startIdx; idx < segmentLength; idx++) {
          const currCol = slice * segmentLength + idx;
          const prevCol = currCol === 0 ? laneLength - 1 : currCol - 1;
          let j1: number;
          let j2: number;
          if (dataIndependent) {
            const addrPos = idx % 128;
            if (
              (addrPos === 0 || (idx === startIdx && startIdx === 2)) &&
              (addrCounter === 0 || addrPos === 0)
            ) {
              addrCounter++;
              inputBlock[12] = addrCounter;
              fillBlock(zeroBlock, 0, inputBlock, 0, addrBlock, 0, false, tmpR, tmpZ);
              fillBlock(zeroBlock, 0, addrBlock, 0, addrBlock, 0, false, tmpR, tmpZ);
            }
            j1 = addrBlock[addrPos * 2] ?? 0;
            j2 = addrBlock[addrPos * 2 + 1] ?? 0;
          } else {
            const prevOff = (lane * laneLength + prevCol) * BLOCK_U32;
            j1 = mem[prevOff] ?? 0;
            j2 = mem[prevOff + 1] ?? 0;
          }

          const refLane = pass === 0 && slice === 0 ? lane : j2 % p;
          let refAreaSize: number;
          if (pass === 0) {
            if (slice === 0) refAreaSize = idx - 1;
            else if (refLane === lane) refAreaSize = slice * segmentLength + idx - 1;
            else refAreaSize = slice * segmentLength - (idx === 0 ? 1 : 0);
          } else if (refLane === lane) {
            refAreaSize = laneLength - segmentLength + idx - 1;
          } else {
            refAreaSize = laneLength - segmentLength - (idx === 0 ? 1 : 0);
          }

          const x = Math.floor((j1 * j1) / 0x100000000);
          const y = Math.floor((refAreaSize * x) / 0x100000000);
          const relPos = refAreaSize - 1 - y;
          const startPos = pass === 0 || slice === 3 ? 0 : (slice + 1) * segmentLength;
          const refCol = (startPos + relPos) % laneLength;

          const prevOff = (lane * laneLength + prevCol) * BLOCK_U32;
          const refOff = (refLane * laneLength + refCol) * BLOCK_U32;
          const currOff = (lane * laneLength + currCol) * BLOCK_U32;
          fillBlock(mem, prevOff, mem, refOff, mem, currOff, pass > 0, tmpR, tmpZ);
        }
      }
    }
  }

  const finalWords = new Uint32Array(BLOCK_U32);
  for (let lane = 0; lane < p; lane++) {
    const off = (lane * laneLength + (laneLength - 1)) * BLOCK_U32;
    for (let i = 0; i < BLOCK_U32; i++) finalWords[i] = (finalWords[i] ?? 0) ^ (mem[off + i] ?? 0);
  }
  const finalBytes = new Uint8Array(1024);
  const finalView = new DataView(finalBytes.buffer);
  for (let i = 0; i < BLOCK_U32; i++) finalView.setUint32(i * 4, finalWords[i] ?? 0, true);
  return blake2bLong(finalBytes, tagLen);
};

export const argon2id: {
  (salt: Uint8Array, params: Argon2idParams): (password: Uint8Array) => Uint8Array;
  (password: Uint8Array, salt: Uint8Array, params: Argon2idParams): Uint8Array;
} = Fn.dual(3, argon2idImpl);

const hexText = /^[0-9a-fA-F]*$/;
