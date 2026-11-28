/**
 * Streams a ZIP64 archive without buffering file contents. Older Java ZipInputStream
 * implementations can misread the 64-bit descriptor for small entries.
 */
import { crc32, createDeflateRaw } from "node:zlib";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface ZipEntry<E, R> {
  readonly name: string;
  readonly bytes: Stream.Stream<Uint8Array, E, R>;
}

// The report upload uses the Cloud Storage object limit, which is a safe JS integer.
export const MAX_ZIP_BYTES = 5 * 1024 ** 4;
const ZIP32_MAX = 0xffffffff;
const ZIP32_MAX_COUNT = 0xffff;
const CENTRAL_HEADER_LENGTH = 46;
const MAX_CENTRAL_RECORD_LENGTH = 0xffff;
const ZIP64_VERSION = 45;
const ZIP64_EXTRA_ID = 1;
const EXTRA_HEADER_SIZE = 4;
const ZIP64_SIZES_LENGTH = 16;
const UTF8_WITH_DESCRIPTOR = 0x0808;
const DEFLATE = 8;
const MODIFIED_DATE = 0x5421;
const encoder = new TextEncoder();

const directoryEnd = (count: number, size: number, offset: bigint) => {
  // Strict libzip readers use this footer to recognize 64-bit descriptors.
  const needsZip64 = count > 0;
  const zip64EndLength = 56;
  const locatorLength = 20;
  const endOffset = needsZip64 ? zip64EndLength + locatorLength : 0;
  const bytes = new Uint8Array(endOffset + 22);

  if (needsZip64) {
    const end = new DataView(bytes.buffer);
    end.setUint32(0, 0x06064b50, true);
    end.setBigUint64(4, BigInt(zip64EndLength - 12), true);
    end.setUint16(12, ZIP64_VERSION, true);
    end.setUint16(14, ZIP64_VERSION, true);
    end.setBigUint64(24, BigInt(count), true);
    end.setBigUint64(32, BigInt(count), true);
    end.setBigUint64(40, BigInt(size), true);
    end.setBigUint64(48, offset, true);

    const locator = new DataView(bytes.buffer, zip64EndLength);
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, offset + BigInt(size), true);
    locator.setUint32(16, 1, true);
  }

  const end = new DataView(bytes.buffer, endOffset);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(count, ZIP32_MAX_COUNT), true);
  end.setUint16(10, Math.min(count, ZIP32_MAX_COUNT), true);
  end.setUint32(12, Math.min(size, ZIP32_MAX), true);
  end.setUint32(16, offset >= ZIP32_MAX ? ZIP32_MAX : Number(offset), true);
  return bytes;
};

export const streamZip = <E, R, SourceE = never, SourceR = never>(
  entries: ReadonlyArray<ZipEntry<E, R>> | Stream.Stream<ZipEntry<E, R>, SourceE, SourceR>,
) =>
  Stream.suspend(() => {
    const centralParts: Array<Uint8Array> = [];
    let centralSize = 0;
    let offset = 0n;

    const source = Stream.TypeId in entries ? entries : Stream.fromIterable(entries);
    const files = source.pipe(
      Stream.flatMap((entry) =>
        Stream.suspend(() => {
          const filename = encoder.encode(entry.name);
          const centralExtra = CENTRAL_HEADER_LENGTH + filename.length;
          if (centralExtra > MAX_CENTRAL_RECORD_LENGTH)
            return Stream.die(new RangeError("ZIP filename is too long"));
          // The header arrives before the sizes are known. Its ZIP64 extra field
          // tells streaming readers to look for a descriptor with 64-bit sizes.
          const localExtra = 30 + filename.length;
          const local = new Uint8Array(localExtra + EXTRA_HEADER_SIZE + ZIP64_SIZES_LENGTH);
          const header = new DataView(local.buffer);
          header.setUint32(0, 0x04034b50, true);
          header.setUint16(4, ZIP64_VERSION, true);
          header.setUint16(6, UTF8_WITH_DESCRIPTOR, true);
          header.setUint16(8, DEFLATE, true);
          header.setUint16(12, MODIFIED_DATE, true);
          header.setUint32(18, ZIP32_MAX, true);
          header.setUint32(22, ZIP32_MAX, true);
          header.setUint16(26, filename.length, true);
          header.setUint16(28, EXTRA_HEADER_SIZE + ZIP64_SIZES_LENGTH, true);
          local.set(filename, 30);
          header.setUint16(localExtra, ZIP64_EXTRA_ID, true);
          header.setUint16(localExtra + 2, ZIP64_SIZES_LENGTH, true);

          let crc = 0;
          let size = 0;
          let compressedSize = 0;
          const compressed = entry.bytes.pipe(
            Stream.tap((chunk) =>
              Effect.suspend(() => {
                size += chunk.byteLength;
                if (size > MAX_ZIP_BYTES)
                  return Effect.die(new RangeError("ZIP entry is too large"));
                crc = crc32(chunk, crc);
                return Effect.void;
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
            const descriptor = new Uint8Array(24);
            const values = new DataView(descriptor.buffer);
            values.setUint32(0, 0x08074b50, true);
            values.setUint32(4, crc, true);
            values.setBigUint64(8, BigInt(compressedSize), true);
            values.setBigUint64(16, BigInt(size), true);

            const zip64Sizes = size >= ZIP32_MAX || compressedSize >= ZIP32_MAX;
            const zip64Offset = offset >= ZIP32_MAX;
            const sizesLength = zip64Sizes ? ZIP64_SIZES_LENGTH : 0;
            const extraDataLength = sizesLength + (zip64Offset ? 8 : 0);
            const extraLength = extraDataLength === 0 ? 0 : EXTRA_HEADER_SIZE + extraDataLength;
            const centralLength = centralExtra + extraLength;
            if (centralLength > MAX_CENTRAL_RECORD_LENGTH) {
              return Stream.die(new RangeError("ZIP filename is too long"));
            }
            const central = new Uint8Array(centralLength);
            const index = new DataView(central.buffer);
            index.setUint32(0, 0x02014b50, true);
            index.setUint16(4, ZIP64_VERSION, true);
            index.setUint16(6, ZIP64_VERSION, true);
            index.setUint16(8, UTF8_WITH_DESCRIPTOR, true);
            index.setUint16(10, DEFLATE, true);
            index.setUint16(14, MODIFIED_DATE, true);
            index.setUint32(16, crc, true);
            index.setUint32(20, zip64Sizes ? ZIP32_MAX : compressedSize, true);
            index.setUint32(24, zip64Sizes ? ZIP32_MAX : size, true);
            index.setUint16(28, filename.length, true);
            index.setUint16(30, extraLength, true);
            index.setUint32(42, zip64Offset ? ZIP32_MAX : Number(offset), true);
            central.set(filename, CENTRAL_HEADER_LENGTH);
            if (extraLength > 0) {
              index.setUint16(centralExtra, ZIP64_EXTRA_ID, true);
              index.setUint16(centralExtra + 2, extraDataLength, true);
              const extraData = centralExtra + EXTRA_HEADER_SIZE;
              if (zip64Sizes) {
                index.setBigUint64(extraData, BigInt(size), true);
                index.setBigUint64(extraData + 8, BigInt(compressedSize), true);
              }
              if (zip64Offset) index.setBigUint64(extraData + sizesLength, offset, true);
            }
            centralParts.push(central);
            centralSize += central.length;
            offset += BigInt(local.length + compressedSize + descriptor.length);
            return Stream.make(descriptor);
          });
          return Stream.make(local).pipe(Stream.concat(compressed), Stream.concat(finish));
        }),
      ),
    );

    return files.pipe(
      Stream.concat(
        Stream.suspend(() =>
          Stream.fromIterable(centralParts).pipe(
            Stream.concat(Stream.make(directoryEnd(centralParts.length, centralSize, offset))),
          ),
        ),
      ),
    );
  });
