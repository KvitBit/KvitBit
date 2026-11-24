import { describe, expect, test } from "bun:test";
import { argbToHex, makeAndroidDynamicColorReader } from "./dynamic-color.android";

describe("dynamic-color.android", () => {
  test("argbToHex strips alpha and formats uppercase #RRGGBB", () => {
    expect(argbToHex(0xff1f5faf)).toBe("#1F5FAF");
    expect(argbToHex(0x80000a0b)).toBe("#000A0B");
    expect(argbToHex(Number.NaN)).toBeNull();
  });

  test("returns null on non-Android or Android < 12 (API < 31)", async () => {
    const iosReader = makeAndroidDynamicColorReader(() => ({
      os: "ios",
      version: 18,
      resolveResource: () => 0xff112233,
    }));
    expect(await iosReader()).toBeNull();

    const oldAndroid = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 30,
      resolveResource: () => 0xff112233,
    }));
    expect(await oldAndroid()).toBeNull();
  });

  test("returns Roles palette on Android 12+ when Monet system roles resolve", async () => {
    const table: Record<string, number> = {
      "@android:color/system_accent1_600": 0xff2b5ea7,
      "@android:color/system_accent1_200": 0xffa8c7fa,
      "@android:color/system_neutral1_10": 0xfffdfcff,
      "@android:color/system_neutral1_900": 0xff1a1c1e,
    };
    const reader = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 34,
      resolveResource: (name) => table[name] ?? null,
    }));
    expect(await reader()).toEqual({
      _tag: "Roles",
      light: { primary: "#2B5EA7", surface: "#FDFCFF" },
      dark: { primary: "#A8C7FA", surface: "#1A1C1E" },
    });
  });

  test("falls back to Seed when only system_accent1_500 resolves, and null when none resolve", async () => {
    const seedOnly = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 31,
      resolveResource: (name) => (name === "@android:color/system_accent1_500" ? 0xff0f5d42 : null),
    }));
    expect(await seedOnly()).toEqual({ _tag: "Seed", seed: "#0F5D42" });

    const broken = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 33,
      resolveResource: () => {
        throw new Error("unsupported");
      },
    }));
    expect(await broken()).toBeNull();
  });
});
