/** Negative fixture: a replay harness whose only test is skipped, so it checks nothing. */
import { test } from "bun:test";

test.skip("a replay step that never runs", () => {});
