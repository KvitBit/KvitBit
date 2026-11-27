import { describe, expect, test } from "bun:test";
import { KvitbitDefaultTheme } from "@kvitbit/ui-port/theme";
import * as Option from "effect/Option";
import { appTheme, DEFAULT_PREFERENCE, deviceDynamicRoles, themeStateOf } from "./theme-state";

const device = { scheme: "light", highContrast: false, dynamic: null } as const;

describe("theme state", () => {
  test("no dynamic palette falls back to the Kvitbit default", () => {
    const theme = appTheme(themeStateOf(device, DEFAULT_PREFERENCE));
    expect(theme.effective.origin).toBe("default");
    expect(theme.native.colors.primary).toBe(KvitbitDefaultTheme.schemes.light.roles.primary);
    expect(theme.native.dark).toBe(false);
  });

  test("a device dynamic palette wins while the preference allows it", () => {
    const dynamic = { _tag: "Seed", seed: "#6750A4" } as const;
    const on = appTheme(themeStateOf({ ...device, dynamic }, DEFAULT_PREFERENCE));
    expect(on.effective.origin).toBe("dynamic");
    const off = appTheme(
      themeStateOf({ ...device, dynamic }, { ...DEFAULT_PREFERENCE, dynamicColor: false }),
    );
    expect(off.effective.origin).toBe("default");
  });

  test("a malformed platform report counts as no dynamic colour", () => {
    const roles = deviceDynamicRoles({ _tag: "Seed", seed: "nope" });
    expect(Option.isNone(roles)).toBe(true);
  });

  test("system dark scheme and OS high contrast reach the effective theme", () => {
    const theme = appTheme(
      themeStateOf({ scheme: "dark", highContrast: true, dynamic: null }, DEFAULT_PREFERENCE),
    );
    expect(theme.native.dark).toBe(true);
    expect(theme.effective.contrast).toBe("medium");
  });
});
