import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
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
