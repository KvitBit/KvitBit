/** The replay runner must resolve package names through formal/tsconfig.json. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeMemoryStore } from "../../packages/core/src/testing/index";
import { CurrencyCode, MoneyMath } from "../../packages/domain/src/index";

const workspacePackages = {
  testing: "@kvitbit/core/testing",
  domain: "@kvitbit/domain",
};

test("a formal/ harness runs real @kvitbit code", async () => {
  const testing: unknown = await import(workspacePackages.testing);
  const domain: unknown = await import(workspacePackages.domain);
  expect(testing).toMatchObject({ makeMemoryStore });
  expect(domain).toMatchObject({ CurrencyCode, MoneyMath });

  const czk = CurrencyCode.make("CZK");
  expect(MoneyMath.toMinorUnits(MoneyMath.fromMinorUnits(12345n, czk))).toBe(12345n);
  const store = await Effect.runPromise(makeMemoryStore);
  expect(store).toBeDefined();
});
