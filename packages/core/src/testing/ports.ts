/**
 * In-memory driven ports for tests (core-ports 6, 10). Each fake comes with a control service
 * (fixtures, captured output, failure injection); `X.layer` provides both.
 */

import type { IsoDate } from "@kvitbit/domain/contract";
import type { BlobKey, CnbFixing, OutboundEmail, RegistryRecord } from "@kvitbit/domain/ports";
import {
  BlobMissing,
  BlobStorage,
  BlobTooLarge,
  BlobUnavailable,
  CompanyRegistry,
  EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailRejected,
  EmailSender,
  ExchangeRates,
  RatesUnavailable,
  RegistryUnavailable,
} from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { sha256Hex } from "../shared/hash";

// CompanyRegistry ---------------------------------------------------------------------------

export class FakeCompanyRegistry extends Context.Service<
  FakeCompanyRegistry,
  {
    readonly records: Ref.Ref<ReadonlyMap<string, RegistryRecord>>;
    /** While true, every lookup fails with RegistryUnavailable. */
    readonly unavailable: Ref.Ref<boolean>;
    /** IČOs looked up, in order. */
    readonly lookups: Ref.Ref<ReadonlyArray<string>>;
  }
>()("@kvitbit/core/testing/ports/FakeCompanyRegistry") {
  static readonly layer = (
    fixtures: Readonly<Record<string, RegistryRecord>> = {},
  ): Layer.Layer<FakeCompanyRegistry | CompanyRegistry> =>
    Layer.effect(
      CompanyRegistry,
      Effect.map(FakeCompanyRegistry, (fake) => ({
        lookup: Effect.fn("lookup")(function* (ico: string) {
          yield* Ref.update(fake.lookups, (all) => [...all, ico]);
          if (yield* Ref.get(fake.unavailable)) return yield* new RegistryUnavailable({});
          return (yield* Ref.get(fake.records)).get(ico) ?? null;
        }),
      })),
    ).pipe(
      Layer.provideMerge(
        Layer.effect(
          FakeCompanyRegistry,
          Effect.all(
            {
              records: Ref.make<ReadonlyMap<string, RegistryRecord>>(
                new Map(EffectRecord.toEntries(fixtures)),
              ),
              unavailable: Ref.make(false),
              lookups: Ref.make<ReadonlyArray<string>>([]),
            },
            { concurrency: 1 },
          ),
        ),
      ),
    );
}

// ExchangeRates -----------------------------------------------------------------------------

export class FixtureRates extends Context.Service<
  FixtureRates,
  {
    readonly fixings: Ref.Ref<ReadonlyArray<CnbFixing>>;
    readonly unavailable: Ref.Ref<boolean>;
  }
>()("@kvitbit/core/testing/ports/FixtureRates") {
  /**
   * `fixing(date)` returns the latest fixing with `fixingDate <= date` (weekends and holidays
   * carry back); a date before every fixing fails with RatesUnavailable.
   */
  static readonly layer = (
    fixings: ReadonlyArray<CnbFixing> = [],
  ): Layer.Layer<FixtureRates | ExchangeRates> =>
    Layer.effect(
      ExchangeRates,
      Effect.map(FixtureRates, (fake) => ({
        fixing: Effect.fn("fixing")(function* (date: IsoDate) {
          if (yield* Ref.get(fake.unavailable)) return yield* new RatesUnavailable({});
          let best: CnbFixing | undefined;
          for (const f of yield* Ref.get(fake.fixings)) {
            if (f.fixingDate <= date && (best === undefined || f.fixingDate > best.fixingDate)) {
              best = f;
            }
          }
          if (best === undefined) {
            return yield* new RatesUnavailable({ cause: `no fixing on or before ${date}` });
          }
          return best;
        }),
      })),
    ).pipe(
      Layer.provideMerge(
        Layer.effect(
          FixtureRates,
          Effect.all(
            { fixings: Ref.make(fixings), unavailable: Ref.make(false) },
            { concurrency: 1 },
          ),
        ),
      ),
    );
}

// EmailSender -------------------------------------------------------------------------------

export type EmailFailure = EmailRejected | EmailNotAccepted | EmailOutcomeUnknown;

export interface CapturedEmail {
  readonly message: OutboundEmail;
  readonly idempotencyKey: string;
  readonly providerMessageId: string;
}

export class CaptureEmailSender extends Context.Service<
  CaptureEmailSender,
  {
    /** Accepted messages, in order. A repeated idempotency key is accepted once (deduped). */
    readonly sent: Ref.Ref<ReadonlyArray<CapturedEmail>>;
    /** Failures returned by the next sends, first in first out. */
    readonly failures: Ref.Ref<ReadonlyArray<EmailFailure>>;
    /** Every send attempt, including failed and deduped ones. */
    readonly attempts: Ref.Ref<number>;
  }
>()("@kvitbit/core/testing/ports/CaptureEmailSender") {
  static readonly failNext = (
    ...failures: ReadonlyArray<"rejected" | "not_accepted" | "outcome_unknown">
  ): Effect.Effect<void, never, CaptureEmailSender> =>
    Effect.flatMap(CaptureEmailSender, (capture) =>
      Ref.update(capture.failures, (queue) => [
        ...queue,
        ...EffectArray.map(failures, (kind) =>
          kind === "rejected"
            ? new EmailRejected({})
            : kind === "not_accepted"
              ? new EmailNotAccepted({})
              : new EmailOutcomeUnknown({}),
        ),
      ]),
    );

  static readonly layer: Layer.Layer<CaptureEmailSender | EmailSender> = Layer.effect(
    EmailSender,
    Effect.map(CaptureEmailSender, (capture) => ({
      send: Effect.fn("send")(function* (
        message: OutboundEmail,
        opts: { readonly idempotencyKey: string },
      ) {
        yield* Ref.update(capture.attempts, (n) => n + 1);
        const failure = yield* Ref.modify(capture.failures, (queue) => [queue[0], queue.slice(1)]);
        if (failure !== undefined) return yield* failure;
        const sent = yield* Ref.get(capture.sent);
        const previous = Option.getOrUndefined(
          EffectArray.findFirst(sent, (e) => e.idempotencyKey === opts.idempotencyKey),
        );
        if (previous !== undefined) {
          return { provider: "capture", providerMessageId: previous.providerMessageId };
        }
        const providerMessageId = `capture-${sent.length + 1}`;
        yield* Ref.set(capture.sent, [
          ...sent,
          { message, idempotencyKey: opts.idempotencyKey, providerMessageId },
        ]);
        return { provider: "capture", providerMessageId };
      }),
    })),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        CaptureEmailSender,
        Effect.all(
          {
            sent: Ref.make<ReadonlyArray<CapturedEmail>>([]),
            failures: Ref.make<ReadonlyArray<EmailFailure>>([]),
            attempts: Ref.make(0),
          },
          { concurrency: 1 },
        ),
      ),
    ),
  );
}

// BlobStorage -------------------------------------------------------------------------------

export interface StoredBlob {
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export class MemoryBlobStorage extends Context.Service<
  MemoryBlobStorage,
  {
    readonly blobs: Ref.Ref<ReadonlyMap<BlobKey, StoredBlob>>;
    readonly unavailable: Ref.Ref<boolean>;
  }
>()("@kvitbit/core/testing/ports/MemoryBlobStorage") {
  static readonly layer: Layer.Layer<MemoryBlobStorage | BlobStorage> = Layer.effect(
    BlobStorage,
    Effect.map(MemoryBlobStorage, (memory) => {
      const guard = Effect.flatMap(Ref.get(memory.unavailable), (down) =>
        down ? Effect.fail(new BlobUnavailable({})) : Effect.void,
      );
      return {
        put: Effect.fn("put")(function* (
          key: BlobKey,
          body: Stream.Stream<Uint8Array>,
          meta: { readonly contentType: string; readonly maxBytes: number },
        ) {
          yield* guard;
          // Stop reading at the first chunk past the limit, like a streaming upload.
          const chunks: Array<Uint8Array> = [];
          let size = 0;
          yield* Stream.runForEach(body, (chunk) => {
            size += chunk.byteLength;
            if (size > meta.maxBytes)
              return Effect.fail(new BlobTooLarge({ maxBytes: meta.maxBytes }));
            // Copy now: a producer may reuse its buffer (Buffer#slice shares memory).
            chunks.push(new Uint8Array(chunk));
            return Effect.void;
          });
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const sha256 = yield* sha256Hex(bytes);
          yield* Ref.update(memory.blobs, (all) =>
            new Map(all).set(key, { contentType: meta.contentType, bytes, sha256 }),
          );
          return { key, bytes: size, sha256 };
        }),
        get: Effect.fn("get")(function* (key: BlobKey) {
          yield* guard;
          const blob = (yield* Ref.get(memory.blobs)).get(key);
          if (blob === undefined) return yield* new BlobMissing({ key });
          return Stream.succeed(new Uint8Array(blob.bytes)); // detached copy
        }),
        delete: (key: BlobKey) =>
          Effect.andThen(
            guard,
            Ref.update(memory.blobs, (all) => {
              const next = new Map(all);
              next.delete(key);
              return next;
            }),
          ),
      };
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        MemoryBlobStorage,
        Effect.all(
          {
            blobs: Ref.make<ReadonlyMap<BlobKey, StoredBlob>>(new Map()),
            unavailable: Ref.make(false),
          },
          { concurrency: 1 },
        ),
      ),
    ),
  );
}
