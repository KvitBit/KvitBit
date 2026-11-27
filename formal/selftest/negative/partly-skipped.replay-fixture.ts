/** Negative fixture: a replay harness that skips one of its steps. */
import { expect, test } from "bun:test";

test("a replay step that runs", () => {
  expect(1 + 1).toBe(2);
});

test.skipIf(true)("a replay step that never runs", () => {
  throw new Error("skipped replay fixture ran");
});
