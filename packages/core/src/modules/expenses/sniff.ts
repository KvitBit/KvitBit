/**
 * Magic-byte check of attachment uploads (http-mcp-contracts 3.4: "core sniffs magic bytes, not
 * only the declared type"). The declared type must be allowed and the content must start with
 * that type's signature.
 */
import { Stream } from "effect";

/** Bytes needed to decide every supported type (HEIC: `....ftypheic`). */
const PREFIX = 12;

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const HEIF_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"];

const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "application/pdf": (b) => startsWith(b, ascii("%PDF-")),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/heic": (b) =>
    startsWith(b, ascii("ftyp"), 4) && HEIF_BRANDS.some((brand) => startsWith(b, ascii(brand), 8)),
};

/** Whether `prefix` (the first bytes of the content) matches the declared `contentType`. */
export const matchesType = (contentType: string, prefix: Uint8Array): boolean =>
  SIGNATURES[contentType]?.(prefix) ?? false;

/** Content types the sniffer knows; an allowed type outside this list is never accepted. */
export const SNIFFABLE_TYPES: ReadonlyArray<string> = Object.keys(SIGNATURES);

/**
 * Wraps `bytes` so the prefix is checked while streaming: the stream ends early at the first
 * chunk that proves a mismatch, so a spoofed upload is not stored whole. Call `verdict()` after
 * the stream was consumed; an empty or short stream is decided on what arrived.
 */
export const sniffing = (contentType: string, bytes: Stream.Stream<Uint8Array>) => {
  let prefix = new Uint8Array(0);
  let decided: boolean | undefined;
  const stream = Stream.takeWhile(bytes, (chunk: Uint8Array) => {
    if (decided === undefined) {
      const next = new Uint8Array(Math.min(PREFIX, prefix.length + chunk.length));
      next.set(prefix.subarray(0, next.length));
      if (next.length > prefix.length) {
        next.set(chunk.subarray(0, next.length - prefix.length), prefix.length);
      }
      prefix = next;
      if (prefix.length >= PREFIX) decided = matchesType(contentType, prefix);
    }
    return decided !== false;
  });
  return { stream, verdict: () => decided ?? matchesType(contentType, prefix) };
};
