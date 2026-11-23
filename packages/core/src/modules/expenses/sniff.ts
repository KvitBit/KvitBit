/**
 * Magic-byte check of attachment uploads (http-mcp-contracts 3.4: "core sniffs magic bytes, not
 * only the declared type"). The declared type must be allowed and the content must start with
 * that type's signature. The check runs incrementally while streaming and keeps only a few bytes.
 */
import { Stream } from "effect";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Fixed-prefix signatures. */
const PREFIXES: Readonly<Record<string, ReadonlyArray<number>>> = {
  "application/pdf": ascii("%PDF-"),
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

/** HEIC still-image brands registered for image/heic (IANA; ISO/IEC 23008-12 Annex B). */
export const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis"]);

const HEIC = "image/heic";

/** Content types the sniffer knows; an allowed type outside this list is never accepted. */
export const SNIFFABLE_TYPES: ReadonlyArray<string> = [...Object.keys(PREFIXES), HEIC];

/** An incremental decision: `true` / `false` once known, `undefined` while more bytes are needed. */
interface Sniffer {
  readonly feed: (chunk: Uint8Array) => boolean | undefined;
  /** The decision at end of stream. */
  readonly end: () => boolean;
}

const prefixSniffer = (signature: ReadonlyArray<number>): Sniffer => {
  let seen = 0;
  let verdict: boolean | undefined;
  return {
    feed: (chunk) => {
      for (let i = 0; i < chunk.length && verdict === undefined; i++) {
        if (chunk[i] !== signature[seen]) verdict = false;
        else if (++seen === signature.length) verdict = true;
      }
      return verdict;
    },
    end: () => verdict ?? false,
  };
};

/**
 * `image/heic`: the file starts with an `ftyp` box whose major brand or one of its 4-byte
 * aligned compatible brands (up to the end of the box) is a HEIC still-image brand. Generic HEIF
 * (`mif1` alone) and image sequences (`msf1`, `hevc`) are not HEIC. Keeps at most 16 bytes.
 */
const heicSniffer = (): Sniffer => {
  const head: Array<number> = []; // the first 16 bytes: size, "ftyp", major, minor
  let size = 0;
  let pos = 0; // bytes consumed
  let brand: Array<number> = [];
  let verdict: boolean | undefined;
  const isHeic = (bytes: ReadonlyArray<number>) => HEIC_BRANDS.has(String.fromCharCode(...bytes));
  const onHead = () => {
    size =
      (head[0] ?? 0) * 2 ** 24 + ((head[1] ?? 0) << 16) + ((head[2] ?? 0) << 8) + (head[3] ?? 0);
    if (String.fromCharCode(...head.slice(4, 8)) !== "ftyp" || size < 16 || size % 4 !== 0) {
      return false;
    }
    if (isHeic(head.slice(8, 12))) return true;
    return size === 16 ? false : undefined;
  };
  return {
    feed: (chunk) => {
      for (let i = 0; i < chunk.length && verdict === undefined; i++, pos++) {
        const byte = chunk[i] ?? 0;
        if (pos < 16) {
          head.push(byte);
          if (pos === 15) verdict = onHead();
          continue;
        }
        brand.push(byte);
        if (brand.length === 4) {
          if (isHeic(brand)) verdict = true;
          brand = [];
        }
        if (verdict === undefined && pos + 1 >= size) verdict = false;
      }
      return verdict;
    },
    end: () => verdict ?? false,
  };
};

const snifferFor = (contentType: string): Sniffer => {
  if (contentType === HEIC) return heicSniffer();
  const signature = PREFIXES[contentType];
  return signature === undefined
    ? { feed: () => false, end: () => false }
    : prefixSniffer(signature);
};

/** Whether `bytes` (a whole file or its start) match the declared `contentType`. */
export const matchesType = (contentType: string, bytes: Uint8Array): boolean => {
  const sniffer = snifferFor(contentType);
  return sniffer.feed(bytes) ?? sniffer.end();
};

/**
 * Wraps `bytes` so the signature is checked while streaming: the stream ends early at the first
 * chunk that proves a mismatch, so a spoofed upload is not stored whole. Call `verdict()` after
 * the stream was consumed; an empty or short stream is decided on what arrived.
 */
export const sniffing = (contentType: string, bytes: Stream.Stream<Uint8Array>) => {
  const sniffer = snifferFor(contentType);
  let decided: boolean | undefined;
  const stream = Stream.takeWhile(bytes, (chunk: Uint8Array) => {
    if (decided === undefined) decided = sniffer.feed(chunk);
    return decided !== false;
  });
  return { stream, verdict: () => decided ?? sniffer.end() };
};
