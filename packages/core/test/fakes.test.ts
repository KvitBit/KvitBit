import { describe, expect, test } from "bun:test";
import type { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import type { BlobKey, CnbFixing, OutboundEmail } from "@kvitbit/domain/ports";
import {
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
import { BigDecimal, Effect, Exit, Ref, Stream } from "effect";
import {
  CaptureEmailSender,
  FakeCompanyRegistry,
  FixtureRates,
  MemoryBlobStorage,
} from "../src/testing";
import { account, runTest } from "./helpers";

const fixing = (fixingDate: string, rate: string): CnbFixing => ({
  fixingDate: fixingDate as IsoDate,
  sequence: 1,
  rates: [{ code: "EUR" as CurrencyCode, quantity: 1, rate: BigDecimal.fromStringUnsafe(rate) }],
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
        const saturday = yield* rates.fixing("2026-11-21" as IsoDate);
        const friday = yield* rates.fixing("2026-11-20" as IsoDate);
        const before = yield* Effect.flip(rates.fixing("2026-11-01" as IsoDate));
        return [saturday.fixingDate, friday.fixingDate, before._tag] as ReadonlyArray<string>;
      }),
      { fixings: [fixing("2026-11-19", "25.1"), fixing("2026-11-20", "25.2")] },
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      "2026-11-20",
      "2026-11-20",
      "RatesUnavailable",
    ]);
  });

  test("FixtureRates and FakeCompanyRegistry can be switched unavailable", async () => {
    const exit = await runTest(
      account(),
      Effect.gen(function* () {
        yield* Ref.set((yield* FixtureRates).unavailable, true);
        yield* Ref.set((yield* FakeCompanyRegistry).unavailable, true);
        const rates = yield* Effect.flip((yield* ExchangeRates).fixing("2026-11-20" as IsoDate));
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
    const key = "ws/a/file.txt" as BlobKey;
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
        return { put, read: read.map((c) => [...c]), tooLarge, missing, stored };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        put: {
          key,
          bytes: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
        read: [[97, 98, 99]],
        tooLarge: new BlobTooLarge({ maxBytes: 2 }),
        missing: new BlobMissing({ key }),
        stored: 0,
      }),
    );
  });
});
