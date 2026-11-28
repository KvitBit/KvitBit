/** Negative fixture: a replay harness whose only test is skipped, so it checks nothing. */
import { test } from "bun:test";

test.skipIf(true)("a replay step that never runs", () => {
  throw new Error("skipped replay fixture ran");
});
