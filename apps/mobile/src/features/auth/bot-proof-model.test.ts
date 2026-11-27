import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { BotProofState } from "../../platform/altcha/bot-proof";
import { eventually } from "../../testing/eventually";
import { makeBotProof } from "./bot-proof-model";

describe("makeBotProof", () => {
  test("transitions Fetching -> Solving -> Solved and caches fresh solution", async () => {
    const states: BotProofState[] = [];
    let fetchCount = 0;
    const now = 1_000_000;
    const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(now + 60_000));

    const controller = makeBotProof({
      origin: "https://kvitbit.test",
      scope: "sign_up",
      now: () => now,
      onState: (s) => states.push(s),
      fetchChallenge: () => {
        fetchCount += 1;
        return Promise.resolve({ _tag: "Challenge", challenge: { parameters: {} } });
      },
      solveChallenge: (_ch, opts) => {
        opts?.onProgress?.(0.5);
        return Promise.resolve({ _tag: "Solved", payload: "b64-proof", expiresAt });
      },
    });

    const first = await controller.start();
    expect(first).toEqual({ _tag: "Solved", payload: "b64-proof", expiresAt });
    expect(Arr.map(states, (s) => s._tag)).toEqual(["Fetching", "Solving", "Solving", "Solved"]);
    expect(controller.isExpired()).toBe(false);

    // Calling start or ensureFresh again while fresh reuses the solved payload
    const second = await controller.ensureFresh();
    expect(second).toEqual(first);
    expect(fetchCount).toBe(1);
  });

  test("refetches when solved proof is within expiry margin", async () => {
    let clock = 1_000_000;
    let fetchCount = 0;
    const controller = makeBotProof({
      origin: "https://kvitbit.test",
      scope: "sign_up",
      now: () => clock,
      marginMs: 10_000,
      onState: () => undefined,
      fetchChallenge: () => {
        fetchCount += 1;
        return Promise.resolve({ _tag: "Challenge", challenge: { parameters: { n: fetchCount } } });
      },
      solveChallenge: async () => ({
        _tag: "Solved",
        payload: `proof-${fetchCount}`,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock + 30_000)),
      }),
    });

    const s1 = await controller.start();
    expect(s1._tag === "Solved" && s1.payload).toBe("proof-1");

    // Advance clock to within 10s margin -> expired
    clock += 25_000;
    expect(controller.isExpired()).toBe(true);
    const s2 = await controller.ensureFresh();
    expect(s2._tag === "Solved" && s2.payload).toBe("proof-2");
    expect(fetchCount).toBe(2);
  });

  test("handles 204 NotRequired and aborts superseded run on restart", async () => {
    const noop = makeBotProof({
      origin: "https://kvitbit.test",
      scope: "sign_in",
      onState: () => undefined,
      fetchChallenge: async () => ({ _tag: "NotRequired" }),
      solveChallenge: async () => ({ _tag: "Aborted" }),
    });
    expect(await noop.start()).toEqual({ _tag: "NotRequired" });

    let abortedFirst = false;
    let call = 0;
    const racing = makeBotProof({
      origin: "https://kvitbit.test",
      scope: "magic_link",
      onState: () => undefined,
      fetchChallenge: async () => ({ _tag: "Challenge", challenge: { parameters: {} } }),
      solveChallenge: async (_c, opts) => {
        call += 1;
        const myCall = call;
        if (myCall === 1) {
          await Effect.runPromise(
            Effect.callback<void>((resume) => {
              const signal = opts?.signal;
              const onAbort = () => {
                abortedFirst = true;
                resume(Effect.void);
              };
              if (signal?.aborted === true) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            }),
          );
          return { _tag: "Aborted" };
        }
        return { _tag: "Solved", payload: "second", expiresAt: null };
      },
    });

    const p1 = racing.start();
    await Effect.runPromise(eventually(() => call === 1));
    const p2 = racing.restart();
    await p1;
    const res2 = await p2;
    expect(abortedFirst).toBe(true);
    expect(res2).toEqual({ _tag: "Solved", payload: "second", expiresAt: null });
  });
});
