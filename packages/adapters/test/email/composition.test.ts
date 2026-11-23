import { describe, expect, test } from "bun:test";
import {
  CAPTURE_PROVIDER,
  type EmailSenderService,
  layerCapture,
  makeAllowlistEmailSender,
  makeCaptureEmailSender,
  makeConsoleEmailSender,
  makeFallbackEmailSender,
} from "@kvitbit/adapters/email";
import {
  EmailNotAccepted,
  EmailOutcomeUnknown,
  EmailRejected,
  EmailSender,
  type OutboundEmail,
} from "@kvitbit/domain/ports";
import { Effect, Exit, Logger } from "effect";
import { message } from "./fixtures";

type SendError = EmailRejected | EmailNotAccepted | EmailOutcomeUnknown;

const scripted = (provider: string, outcome: "ok" | SendError) => {
  const calls: Array<{ message: OutboundEmail; key: string }> = [];
  const sender: EmailSenderService = {
    send: (m, { idempotencyKey }) =>
      Effect.suspend(() => {
        calls.push({ message: m, key: idempotencyKey });
        return outcome === "ok"
          ? Effect.succeed({ provider, providerMessageId: `${provider}-id` })
          : Effect.fail(outcome);
      }),
  };
  return { sender, calls };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));

describe("FallbackEmailSender", () => {
  test("uses the primary when it accepts", async () => {
    const primary = scripted("resend", "ok");
    const secondary = scripted("smtp", "ok");
    const exit = await run(
      makeFallbackEmailSender(primary.sender, secondary.sender).send(message(), {
        idempotencyKey: "k1",
      }),
    );
    expect(exit).toEqual(Exit.succeed({ provider: "resend", providerMessageId: "resend-id" }));
    expect(secondary.calls).toHaveLength(0);
  });

  test("fails over with the same key on EmailNotAccepted", async () => {
    const primary = scripted("resend", new EmailNotAccepted({ cause: { status: 503 } }));
    const secondary = scripted("smtp", "ok");
    const exit = await run(
      makeFallbackEmailSender(primary.sender, secondary.sender).send(message(), {
        idempotencyKey: "k1",
      }),
    );
    expect(exit).toEqual(Exit.succeed({ provider: "smtp", providerMessageId: "smtp-id" }));
    expect(secondary.calls.map((c) => c.key)).toEqual(["k1"]);
  });

  test.each([
    ["EmailOutcomeUnknown", new EmailOutcomeUnknown({})],
    ["EmailRejected", new EmailRejected({})],
  ])("does not fail over on %s", async (tag, error) => {
    const primary = scripted("resend", error);
    const secondary = scripted("smtp", "ok");
    const exit = await run(
      makeFallbackEmailSender(primary.sender, secondary.sender).send(message(), {
        idempotencyKey: "k1",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.map((r) => ("error" in r ? (r.error._tag as string) : "")),
    ).toEqual([tag]);
    expect(secondary.calls).toHaveLength(0);
  });
});

describe("FallbackEmailSender pinning", () => {
  const sequenced = (provider: string, outcomes: Array<"ok" | SendError>) => {
    const calls: Array<string> = [];
    const sender: EmailSenderService = {
      send: (_m, { idempotencyKey }) =>
        Effect.suspend(() => {
          calls.push(idempotencyKey);
          const outcome = outcomes.shift() ?? "ok";
          return outcome === "ok"
            ? Effect.succeed({ provider, providerMessageId: `${provider}-id` })
            : Effect.fail(outcome);
        }),
    };
    return { sender, calls };
  };

  test("a retry after OutcomeUnknown stays on the primary even if it is then refused", async () => {
    const primary = sequenced("resend", [
      new EmailOutcomeUnknown({}),
      new EmailNotAccepted({ cause: { status: 503 } }),
    ]);
    const secondary = sequenced("smtp", []);
    const fallback = makeFallbackEmailSender(primary.sender, secondary.sender);
    const first = await run(fallback.send(message(), { idempotencyKey: "k1" }));
    const retry = await run(fallback.send(message(), { idempotencyKey: "k1" }));
    const other = await run(fallback.send(message(), { idempotencyKey: "k2" }));
    expect(Exit.isFailure(first) && Exit.isFailure(retry)).toBe(true);
    expect(primary.calls).toEqual(["k1", "k1", "k2"]);
    expect(secondary.calls).toEqual([]);
    expect(Exit.isSuccess(other)).toBe(true);
  });

  test("a key that failed over stays on the secondary", async () => {
    const primary = sequenced("resend", [new EmailNotAccepted({})]);
    const secondary = sequenced("smtp", [new EmailOutcomeUnknown({}), "ok"]);
    const fallback = makeFallbackEmailSender(primary.sender, secondary.sender);
    await run(fallback.send(message(), { idempotencyKey: "k1" }));
    const retry = await run(fallback.send(message(), { idempotencyKey: "k1" }));
    expect(retry).toEqual(Exit.succeed({ provider: "smtp", providerMessageId: "smtp-id" }));
    expect(primary.calls).toEqual(["k1"]);
    expect(secondary.calls).toEqual(["k1", "k1"]);
  });

  test("pins are bounded and evict the oldest key", async () => {
    const primary = sequenced("resend", [
      new EmailOutcomeUnknown({}),
      new EmailOutcomeUnknown({}),
      new EmailNotAccepted({}),
    ]);
    const secondary = sequenced("smtp", []);
    const fallback = makeFallbackEmailSender(primary.sender, secondary.sender, {
      maxPinnedKeys: 1,
    });
    await run(fallback.send(message(), { idempotencyKey: "k1" }));
    await run(fallback.send(message(), { idempotencyKey: "k2" }));
    const evicted = await run(fallback.send(message(), { idempotencyKey: "k1" }));
    expect(evicted).toEqual(Exit.succeed({ provider: "smtp", providerMessageId: "smtp-id" }));
    expect(primary.calls).toEqual(["k1", "k2", "k1"]);
  });
});

describe("CaptureEmailSender", () => {
  test("records messages in order and dedupes by idempotency key", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const capture = yield* makeCaptureEmailSender;
        const first = yield* capture.send(message({ subject: "A" }), { idempotencyKey: "k1" });
        yield* capture.send(message({ subject: "B" }), { idempotencyKey: "k2" });
        const again = yield* capture.send(message({ subject: "A" }), { idempotencyKey: "k1" });
        const captured = yield* capture.captured;
        yield* capture.clear;
        return { first, again, captured, cleared: yield* capture.captured };
      }),
    );
    expect(result.first).toEqual({ provider: CAPTURE_PROVIDER, providerMessageId: "capture-1" });
    expect(result.again).toEqual(result.first);
    expect(result.captured.map((c) => [c.idempotencyKey, c.message.subject])).toEqual([
      ["k1", "A"],
      ["k2", "B"],
    ]);
    expect(result.cleared).toEqual([]);
  });

  test("layerCapture provides the EmailSender port", async () => {
    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const capture = yield* makeCaptureEmailSender;
        yield* Effect.gen(function* () {
          const sender = yield* EmailSender;
          yield* sender.send(message(), { idempotencyKey: "k1" });
        }).pipe(Effect.provide(layerCapture(capture)));
        return yield* capture.captured;
      }),
    );
    expect(captured).toHaveLength(1);
  });
});

describe("AllowlistEmailSender", () => {
  const setup = () =>
    Effect.gen(function* () {
      const capture = yield* makeCaptureEmailSender;
      const inner = scripted("resend", "ok");
      const sender = makeAllowlistEmailSender(inner.sender, {
        allow: ["Kvitbit.cz"],
        capture,
      });
      return { capture, inner, sender };
    });

  test("delivers when every recipient is allowlisted", async () => {
    const { inner, captured, result } = await Effect.runPromise(
      Effect.gen(function* () {
        const { capture, inner, sender } = yield* setup();
        const result = yield* sender.send(
          message({ to: ["Jana <jana@KVITBIT.cz>"], cc: ["petr@kvitbit.cz"] }),
          { idempotencyKey: "k1" },
        );
        return { inner, captured: yield* capture.captured, result };
      }),
    );
    expect(result.provider).toBe("resend");
    expect(inner.calls[0]?.message.to).toEqual(["Jana <jana@KVITBIT.cz>"]);
    expect(captured).toHaveLength(0);
  });

  test("captures instead of delivering when no recipient is allowlisted", async () => {
    const { inner, captured, result } = await Effect.runPromise(
      Effect.gen(function* () {
        const { capture, inner, sender } = yield* setup();
        const result = yield* sender.send(message(), { idempotencyKey: "k1" });
        return { inner, captured: yield* capture.captured, result };
      }),
    );
    expect(result.provider).toBe(CAPTURE_PROVIDER);
    expect(inner.calls).toHaveLength(0);
    expect(captured.map((c) => c.message.to)).toEqual([["jana@klient.cz"]]);
  });

  test("splits mixed recipients: allowed ones delivered, the rest captured", async () => {
    const { inner, captured, result } = await Effect.runPromise(
      Effect.gen(function* () {
        const { capture, inner, sender } = yield* setup();
        const result = yield* sender.send(
          message({
            to: ["jana@klient.cz", "qa@kvitbit.cz"],
            cc: ["ops@kvitbit.cz", "x@sub.kvitbit.cz"],
          }),
          { idempotencyKey: "k1" },
        );
        return { inner, captured: yield* capture.captured, result };
      }),
    );
    expect(result.provider).toBe("resend");
    expect(inner.calls.map((c) => [c.message.to, c.message.cc])).toEqual([
      [["qa@kvitbit.cz"], ["ops@kvitbit.cz"]],
    ]);
    expect(captured.map((c) => [c.message.to, c.message.cc])).toEqual([
      [["jana@klient.cz"], ["x@sub.kvitbit.cz"]],
    ]);
  });

  test("promotes an allowed cc to `to` when no `to` recipient is allowed", async () => {
    const { inner } = await Effect.runPromise(
      Effect.gen(function* () {
        const { inner, sender } = yield* setup();
        yield* sender.send(message({ to: ["jana@klient.cz"], cc: ["ops@kvitbit.cz"] }), {
          idempotencyKey: "k1",
        });
        return { inner };
      }),
    );
    expect(inner.calls.map((c) => [c.message.to, c.message.cc])).toEqual([
      [["ops@kvitbit.cz"], []],
    ]);
  });
});

describe("AllowlistEmailSender fails closed", () => {
  test.each([
    "jana@klient.cz, qa@kvitbit.cz",
    "jana@klient.cz;qa@kvitbit.cz",
    '"qa@kvitbit.cz" <jana@klient.cz>',
    "qa@kvitbit.cz <jana@klient.cz>",
    "Team: jana@klient.cz, qa@kvitbit.cz;",
    "jana@klient.cz (qa@kvitbit.cz)",
    "jana@klient.cz@kvitbit.cz",
  ])("captures the ambiguous recipient %p", async (recipient) => {
    const { inner, captured } = await Effect.runPromise(
      Effect.gen(function* () {
        const capture = yield* makeCaptureEmailSender;
        const inner = scripted("resend", "ok");
        const sender = makeAllowlistEmailSender(inner.sender, { allow: ["kvitbit.cz"], capture });
        yield* sender.send(message({ to: [recipient], cc: [] }), { idempotencyKey: "k1" });
        return { inner, captured: yield* capture.captured };
      }),
    );
    expect(inner.calls).toHaveLength(0);
    expect(captured).toHaveLength(1);
  });

  test.each(["qa@kvitbit.cz", "QA Tým <qa@kvitbit.cz>", "  Jana Nováková <qa@KVITBIT.cz>  "])(
    "delivers the single mailbox %p",
    async (recipient) => {
      const inner = scripted("resend", "ok");
      await Effect.runPromise(
        Effect.gen(function* () {
          const capture = yield* makeCaptureEmailSender;
          const sender = makeAllowlistEmailSender(inner.sender, { allow: ["kvitbit.cz"], capture });
          yield* sender.send(message({ to: [recipient], cc: [] }), { idempotencyKey: "k1" });
        }),
      );
      expect(inner.calls).toHaveLength(1);
    },
  );
});

describe("ConsoleEmailSender", () => {
  test("logs instead of sending and returns the key as id", async () => {
    const logs: Array<unknown> = [];
    const logger = Logger.make((options) => {
      logs.push(options.message);
    });
    const result = await Effect.runPromise(
      makeConsoleEmailSender()
        .send(message(), { idempotencyKey: "k1" })
        .pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(result).toEqual({ provider: "console", providerMessageId: "k1" });
    expect(JSON.stringify(logs)).toContain("Faktura 2026-0042");
  });
});
