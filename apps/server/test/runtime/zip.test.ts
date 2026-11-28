import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { streamZip } from "../../src/runtime/zip";

test("the archive emits its first header before reading any file contents", async () => {
  let read = false;
  const bytes = Stream.fromEffect(
    Effect.sync(() => {
      read = true;
      return new TextEncoder().encode("invoice");
    }),
  );
  const headers = await Effect.runPromise(
    streamZip([{ name: "invoice.txt", bytes }]).pipe(Stream.take(1), Stream.runCollect),
  );
  expect(headers[0]?.slice(0, 4)).toEqual(Uint8Array.of(0x50, 0x4b, 0x03, 0x04));
  expect(read).toBe(false);
});

test("taking one header closes the entry stream without pulling a second entry", async () => {
  let next = false;
  let closed = false;
  const entry = { name: "invoice.txt", bytes: Stream.empty };
  const entries = Stream.make(entry).pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.sync(() => {
          next = true;
          return entry;
        }),
      ),
    ),
    Stream.ensuring(
      Effect.sync(() => {
        closed = true;
      }),
    ),
  );

  await entries.pipe(streamZip, Stream.take(1), Stream.runDrain, Effect.runPromise);

  expect(next).toBe(false);
  expect(closed).toBe(true);
});

test("the archive propagates entry enumeration and body failures", async () => {
  const failure = new Error("could not read invoice");
  const sources = [
    Stream.fail(failure),
    Stream.make({ name: "invoice.txt", bytes: Stream.fail(failure) }),
  ];
  const results = await Effect.runPromise(
    Effect.forEach(sources, (source) => source.pipe(streamZip, Stream.runDrain, Effect.flip), {
      concurrency: 1,
    }),
  );
  expect(results[0]).toBe(failure);
  expect(results[1]).toBe(failure);
});

test("an empty archive emits only the classic end record", async () => {
  const chunks = await Effect.runPromise(streamZip<never, never>([]).pipe(Stream.runCollect));
  const archive = Buffer.concat(chunks);

  expect(archive).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)]));
});

test("a small archive advertises its ZIP64 descriptors and keeps usable classic directory fields", async () => {
  const chunks = await Effect.runPromise(
    streamZip([{ name: "invoice.txt", bytes: Stream.empty }]).pipe(Stream.runCollect),
  );
  const archive = Buffer.concat(chunks);
  const footer = new DataView(archive.buffer, archive.byteOffset + archive.byteLength - 98, 98);
  const directoryOffset = footer.getUint32(92, true);
  const directorySize = footer.getUint32(88, true);

  expect(footer.getUint32(0, true)).toBe(0x06064b50);
  expect(footer.getUint32(56, true)).toBe(0x07064b50);
  expect(footer.getBigUint64(64, true)).toBe(BigInt(directoryOffset + directorySize));
  expect(footer.getBigUint64(64, true)).toBe(BigInt(archive.byteLength - footer.byteLength));
  expect(footer.getBigUint64(48, true)).toBe(BigInt(directoryOffset));
  expect(footer.getBigUint64(40, true)).toBe(BigInt(directorySize));
  expect(footer.getUint16(86, true)).toBe(1);
  expect(archive.readUInt32LE(directoryOffset)).toBe(0x02014b50);
});

test("the ZIP64 directory records the first count reserved as a classic sentinel", async () => {
  const count = 65_535;
  const entries = Stream.range(1, count).pipe(
    Stream.map((n) => ({ name: `documents/${n}.pdf`, bytes: Stream.empty })),
  );
  let written = 0;
  let lastChunk: Uint8Array = new Uint8Array(0);

  await entries.pipe(
    streamZip,
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        written += chunk.byteLength;
        lastChunk = chunk;
      }),
    ),
    Effect.runPromise,
  );

  const footer = new DataView(lastChunk.buffer, lastChunk.byteOffset, lastChunk.byteLength);
  expect(footer.getUint32(0, true)).toBe(0x06064b50);
  expect(footer.getBigUint64(24, true)).toBe(BigInt(count));
  expect(footer.getBigUint64(32, true)).toBe(BigInt(count));
  expect(footer.getUint32(56, true)).toBe(0x07064b50);
  expect(footer.getBigUint64(64, true)).toBe(BigInt(written - footer.byteLength));
  expect(footer.getUint32(76, true)).toBe(0x06054b50);
  expect(footer.getUint16(86, true)).toBe(0xffff);
}, 30_000);

test("the ZIP64 descriptor and directory preserve a file size above four GiB", async () => {
  // Reuse one block so the fixture only allocates one MiB of input data.
  const block = new Uint8Array(1024 * 1024);
  const blocks = 4097;
  const bytes = Stream.range(1, blocks).pipe(Stream.map(() => block));
  // 46 fixed central header bytes, 20 extra bytes, and 65,469 UTF-8 name bytes.
  const name = `${Str.repeat(32_734)("é")}x`;

  const archive = await Effect.runPromise(streamZip([{ name, bytes }]).pipe(Stream.runCollect));

  const tail = Buffer.concat(archive.slice(-3));
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const size = BigInt(blocks * block.byteLength);
  const compressedSize = view.getBigUint64(8, true);
  const central = 24;
  const extra = central + 46 + Buffer.byteLength(name);
  expect(view.getUint32(0, true)).toBe(0x08074b50);
  expect(view.getBigUint64(16, true)).toBe(size);
  expect(view.getUint32(central, true)).toBe(0x02014b50);
  expect(view.getUint32(central + 20, true)).toBe(0xffffffff);
  expect(view.getUint32(central + 24, true)).toBe(0xffffffff);
  expect(view.getUint16(extra, true)).toBe(1);
  expect(view.getBigUint64(extra + 4, true)).toBe(size);
  expect(view.getBigUint64(extra + 12, true)).toBe(compressedSize);
}, 30_000);

test("the archive rejects a central record made too long by its ZIP64 size fields", async () => {
  const block = new Uint8Array(1024 * 1024);
  const bytes = Stream.range(1, 4097).pipe(Stream.map(() => block));
  const name = Str.repeat(32_735)("é");

  const archive = streamZip([{ name, bytes }]);
  await expect(archive.pipe(Stream.runDrain, Effect.runPromise)).rejects.toThrow(
    "ZIP filename is too long",
  );
}, 30_000);
