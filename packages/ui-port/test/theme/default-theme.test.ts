import { expect, test } from "bun:test";
import { KvitbitDefaultTheme, resolvePreset } from "../../src/theme";

test("checked-in KvitbitDefaultTheme equals a fresh resolve of graphite_atelier (spec 4.5)", () => {
  expect(KvitbitDefaultTheme).toEqual(resolvePreset("graphite_atelier"));
});
