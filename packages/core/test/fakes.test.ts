import { describe, expect, test } from "bun:test";
import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing, OutboundEmail } from "@kvitbit/domain/ports";
import {
  BlobKey,
  BlobMissing,
  BlobStorage,
  BlobTooLarge,
  CompanyRegistry,
  EmailNotAccepted,
  EmailSender,
  ExchangeRates,
  RatesUnavailable,
  RegistryUnavailable,
} from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { sha256Hex } from "../src/shared/hash";
import {
  CaptureEmailSender,
  FakeCompanyRegistry,
  FixtureRates,
  MemoryBlobStorage,
} from "../src/testing";
import { account, runTest } from "./helpers";

const fixing = (fixingDate: string, rate: string): CnbFixing => ({
  fixingDate: IsoDate.make(fixingDate),
  sequence: 1,
  rates: [{ code: CurrencyCode.make("EUR"), quantity: 1, rate: BigDecimal.fromStringUnsafe(rate) }],
});

const email: OutboundEmail = {
  to: ["buyer@example.cz"],
  replyTo: "owner@example.cz",
  subject: "Invoice",
  html: "<p>Hi</p>",
  text: "Hi",
  attachments: [],
  tags: {},
};

describe("test fakes", () => {
  test("FixtureRates carries back to the latest fixing on or before the date", async () => {
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const rates = yield* ExchangeRates;
        const saturday = yield* rates.fixing(IsoDate.make("2026-11-21"));
        const friday = yield* rates.fixing(IsoDate.make("2026-11-20"));
        const before = yield* Effect.flip(rates.fixing(IsoDate.make("2026-11-01")));
        return [saturday.fixingDate, friday.fixingDate, before._tag];
      }),
      { fixings: [fixing("2026-11-19", "25.1"), fixing("2026-11-20", "25.2")] },
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      IsoDate.make("2026-11-20"),
      IsoDate.make("2026-11-20"),
      "RatesUnavailable",
    ]);
  });

  test("FixtureRates and FakeCompanyRegistry can be switched unavailable", async () => {
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        yield* Ref.set((yield* FixtureRates).unavailable, true);
        yield* Ref.set((yield* FakeCompanyRegistry).unavailable, true);
        const rates = yield* Effect.flip((yield* ExchangeRates).fixing(IsoDate.make("2026-11-20")));
        const registry = yield* Effect.flip((yield* CompanyRegistry).lookup("27074358"));
        return [rates, registry];
      }),
    );
    expect(exit).toEqual(Exit.succeed([new RatesUnavailable({}), new RegistryUnavailable({})]));
  });

  test("FakeCompanyRegistry serves fixtures and records lookups", async () => {
    const record = {
      name: "Acme s.r.o.",
      address: { street: "Main 1", city: "Praha", postalCode: "11000", country: "CZ" },
      dic: "CZ27074358",
      legalForm: "112",
      registerEntry: null,
      terminatedOn: null,
    };
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const registry = yield* CompanyRegistry;
        const found = yield* registry.lookup("27074358");
        const missing = yield* registry.lookup("00000000");
        return [found?.name, missing, yield* Ref.get((yield* FakeCompanyRegistry).lookups)];
      }),
      { registry: { "27074358": record } },
    );
    expect(exit).toEqual(Exit.succeed(["Acme s.r.o.", null, ["27074358", "00000000"]]));
  });

  test("CaptureEmailSender captures, dedupes by key and injects failures", async () => {
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const sender = yield* EmailSender;
        yield* CaptureEmailSender.failNext("not_accepted");
        const failed = yield* Effect.flip(sender.send(email, { idempotencyKey: "d1" }));
        const first = yield* sender.send(email, { idempotencyKey: "d1" });
        const again = yield* sender.send(email, { idempotencyKey: "d1" });
        const capture = yield* CaptureEmailSender;
        return {
          failed,
          same: first.providerMessageId === again.providerMessageId,
          sent: (yield* Ref.get(capture.sent)).length,
          attempts: yield* Ref.get(capture.attempts),
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({ failed: new EmailNotAccepted({}), same: true, sent: 1, attempts: 3 }),
    );
  });

  test("MemoryBlobStorage stores, hashes, enforces maxBytes and deletes", async () => {
    const key = BlobKey.make("ws/a/file.txt");
    const bytes = new TextEncoder().encode("abc");
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const blobs = yield* BlobStorage;
        const put = yield* blobs.put(key, Stream.make(bytes.slice(0, 1), bytes.slice(1)), {
          contentType: "text/plain",
          maxBytes: 10,
        });
        const read = yield* Effect.flatMap(blobs.get(key), Stream.runCollect);
        const tooLarge = yield* Effect.flip(
          blobs.put(key, Stream.make(bytes), { contentType: "text/plain", maxBytes: 2 }),
        );
        yield* blobs.delete(key);
        yield* blobs.delete(key);
        const missing = yield* Effect.flip(blobs.get(key));
        const stored = (yield* Ref.get((yield* MemoryBlobStorage).blobs)).size;
        return { put, read: EffectArray.map(read, (c) => [...c]), tooLarge, missing, stored };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        put: {
          key,
          bytes: 3,
          sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex"),
        },
        read: [[97, 98, 99]],
        tooLarge: new BlobTooLarge({ maxBytes: 2 }),
        missing: new BlobMissing({ key }),
        stored: 0,
      }),
    );
  });

  test("MemoryBlobStorage stops reading at the first chunk past maxBytes", async () => {
    const key = BlobKey.make("ws/a/big.bin");
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const blobs = yield* BlobStorage;
        const body = Stream.concat(
          Stream.make(new Uint8Array([1, 2, 3])),
          Stream.die("the tail must not be read"),
        );
        return yield* Effect.flip(blobs.put(key, body, { contentType: "x", maxBytes: 2 }));
      }),
    );
    expect(exit).toEqual(Exit.succeed(new BlobTooLarge({ maxBytes: 2 })));
  });

  test("MemoryBlobStorage returns detached copies", async () => {
    const key = BlobKey.make("ws/a/two.bin");
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const blobs = yield* BlobStorage;
        const input = new Uint8Array([1, 2]);
        yield* blobs.put(key, Stream.make(input), { contentType: "x", maxBytes: 10 });
        input[0] = 7;
        const first = yield* Effect.flatMap(blobs.get(key), Stream.runCollect);
        const chunk = first[0];
        if (chunk !== undefined) chunk[0] = 9;
        const second = yield* Effect.flatMap(blobs.get(key), Stream.runCollect);
        return EffectArray.map(second, (c) => [...c]);
      }),
    );
    expect(exit).toEqual(Exit.succeed([[1, 2]]));
  });

  test("MemoryBlobStorage copies each chunk as it arrives (a reused Buffer)", async () => {
    const key = BlobKey.make("ws/a/reused.bin");
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        const blobs = yield* BlobStorage;
        const shared = Buffer.alloc(1);
        const body = Stream.fromEffect(
          Effect.sync(() => {
            shared[0] = 1;
            return shared;
          }),
        ).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                shared[0] = 2;
                return shared;
              }),
            ),
          ),
        );
        const receipt = yield* blobs.put(key, body, { contentType: "x", maxBytes: 10 });
        const read = yield* Effect.flatMap(blobs.get(key), Stream.runCollect);
        const bytes = EffectArray.flatMap(read, (c) => [...c]);
        return { bytes, sha: receipt.sha256 === (yield* sha256Hex(new Uint8Array([1, 2]))) };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ bytes: [1, 2], sha: true }));
  });
});
