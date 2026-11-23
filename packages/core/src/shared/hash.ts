/** SHA-256 over the platform Web Crypto global (Bun, Node, browsers); no imports. */
import { Effect } from "effect";

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = (data: string | Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return toHex(
      await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    );
  });
