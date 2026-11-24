/**
 * Runner self-test for the replay contract: a harness under formal/ imports the real code
 * through the `@kvitbit/*` names that formal/tsconfig.json maps to package sources.
 */
import { expect, test } from "bun:test";
import { makeMemoryStore } from "@kvitbit/core/testing";
import type { CurrencyCode } from "@kvitbit/domain";
import { MoneyMath } from "@kvitbit/domain";
import { Effect } from "effect";

test("a formal/ harness runs real @kvitbit code", async () => {
  const czk = "CZK" as CurrencyCode;
  expect(MoneyMath.toMinorUnits(MoneyMath.fromMinorUnits(12345n, czk))).toBe(12345n);
  const store = await Effect.runPromise(makeMemoryStore);
  expect(store).toBeDefined();
});
