/**
 * Negative fixture for the runner self-test: a replay harness that fails. Its name does not
 * match bun's test-file patterns, so only `bun formal/run-formal.ts --selftest` runs it.
 */
import { expect, test } from "bun:test";

test("a replay step that diverges from the real code", () => {
  expect(1 + 1).toBe(3);
});
