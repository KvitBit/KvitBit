/** Streams a classic ZIP archive through the blob store without buffering file contents. */
import { createDeflateRaw } from "node:zlib";
import { NodeStream } from "@effect/platform-node";
import { Effect, Stream } from "effect";

export interface ZipEntry<E, R> {
  readonly name: string;
  readonly bytes: Stream.Stream<Uint8Array, E, R>;
}

// 0xffffffff is the ZIP64 sentinel. BlobStorage also bounds the full upload by this limit.
export const MAX_ZIP_BYTES = 0xfffffffe;
const MAX_ENTRY_COUNT = 0xfffe;
const UTF8_WITH_DESCRIPTOR = 0x0808;
const DEFLATE = 8;
const MODIFIED_DATE = 0x5421;
const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export const streamZip = <E, R>(entries: ReadonlyArray<ZipEntry<E, R>>) =>
  Stream.suspend(() => {
    if (entries.length > MAX_ENTRY_COUNT) throw new RangeError("Too many ZIP entries");
    const centralParts: Array<Uint8Array> = [];
    let offset = 0;

    const files = Stream.fromIterable(entries).pipe(
      Stream.flatMap((entry) =>
        Stream.suspend(() => {
          const filename = encoder.encode(entry.name);
          if (filename.length > 0xffff) throw new RangeError("ZIP filename is too long");
          const local = new Uint8Array(30 + filename.length);
          const header = new DataView(local.buffer);
          header.setUint32(0, 0x04034b50, true);
          header.setUint16(4, 20, true);
          header.setUint16(6, UTF8_WITH_DESCRIPTOR, true);
          header.setUint16(8, DEFLATE, true);
          header.setUint16(12, MODIFIED_DATE, true);
          header.setUint16(26, filename.length, true);
          local.set(filename, 30);

          let crc = 0xffffffff;
          let size = 0;
          let compressedSize = 0;
          const compressed = entry.bytes.pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                size += chunk.byteLength;
                if (size > MAX_ZIP_BYTES) throw new RangeError("ZIP entry is too large");
                for (const byte of chunk) {
                  crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
                }
              }),
            ),
            NodeStream.pipeThroughDuplex({ evaluate: createDeflateRaw }),
            Stream.tap((chunk) =>
              Effect.sync(() => {
                compressedSize += chunk.byteLength;
              }),
            ),
          );

          // The descriptor follows the compressed bytes, when sizes and CRC are known.
          const finish = Stream.suspend(() => {
            const descriptor = new Uint8Array(16);
            const values = new DataView(descriptor.buffer);
            const checksum = (crc ^ 0xffffffff) >>> 0;
            values.setUint32(0, 0x08074b50, true);
            values.setUint32(4, checksum, true);
            values.setUint32(8, compressedSize, true);
            values.setUint32(12, size, true);

            const central = new Uint8Array(46 + filename.length);
            const index = new DataView(central.buffer);
            index.setUint32(0, 0x02014b50, true);
            index.setUint16(4, 20, true);
            index.setUint16(6, 20, true);
            index.setUint16(8, UTF8_WITH_DESCRIPTOR, true);
            index.setUint16(10, DEFLATE, true);
            index.setUint16(14, MODIFIED_DATE, true);
            index.setUint32(16, checksum, true);
            index.setUint32(20, compressedSize, true);
            index.setUint32(24, size, true);
            index.setUint16(28, filename.length, true);
            index.setUint32(42, offset, true);
            central.set(filename, 46);
            centralParts.push(central);
            offset += local.length + compressedSize + descriptor.length;
            return Stream.make(descriptor);
          });
          return Stream.make(local).pipe(Stream.concat(compressed), Stream.concat(finish));
        }),
      ),
    );

    return files.pipe(
      Stream.concat(
        Stream.suspend(() => {
          const size = centralParts.reduce((sum, part) => sum + part.length, 0);
          const end = new Uint8Array(22);
          const index = new DataView(end.buffer);
          index.setUint32(0, 0x06054b50, true);
          index.setUint16(8, centralParts.length, true);
          index.setUint16(10, centralParts.length, true);
          index.setUint32(12, size, true);
          index.setUint32(16, offset, true);
          return Stream.fromIterable(centralParts).pipe(Stream.concat(Stream.make(end)));
        }),
      ),
    );
  });
