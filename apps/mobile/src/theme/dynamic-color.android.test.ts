import { describe, expect, test } from "bun:test";
import { NativeModules, Platform } from "react-native";
import {
  argbToHex,
  makeAndroidDynamicColorReader,
  readDynamicColor,
} from "./dynamic-color.android";

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
    }));
    expect(await iosReader()).toBeNull();

    const oldAndroid = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 30,
    }));
    expect(await oldAndroid()).toBeNull();
  });

  test("returns Roles palette on Android 12+ via native KvitbitDynamicColor bridge", async () => {
    const reader = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 34,
      getNativePalette: async () => ({
        system_accent1_600: 0xff2b5ea7,
        system_accent1_200: 0xffa8c7fa,
        system_neutral1_10: 0xfffdfcff,
        system_neutral1_900: 0xff1a1c1e,
      }),
    }));
    expect(await reader()).toEqual({
      _tag: "Roles",
      light: { primary: "#2B5EA7", surface: "#FDFCFF" },
      dark: { primary: "#A8C7FA", surface: "#1A1C1E" },
    });
  });

  test("production readDynamicColor resolves ARGB integers from NativeModules.KvitbitDynamicColor on API 31+", async () => {
    const origOs = Platform.OS;
    const origVersion = Reflect.get(Platform, "Version");
    const origModule = NativeModules.KvitbitDynamicColor;
    try {
      Reflect.set(Platform, "OS", "android");
      Reflect.set(Platform, "Version", 34);
      NativeModules.KvitbitDynamicColor = {
        getDynamicPalette: async () => ({
          system_accent1_600: 0xff3b6939,
          system_accent1_200: 0xffa0d49b,
          system_neutral1_10: 0xfffcfdf7,
          system_neutral1_900: 0xff1a1c19,
        }),
      };
      expect(await readDynamicColor()).toEqual({
        _tag: "Roles",
        light: { primary: "#3B6939", surface: "#FCFDF7" },
        dark: { primary: "#A0D49B", surface: "#1A1C19" },
      });
    } finally {
      Reflect.set(Platform, "OS", origOs);
      Reflect.set(Platform, "Version", origVersion);
      NativeModules.KvitbitDynamicColor = origModule;
    }
  });

  test("falls back to Seed when only system_accent1_500 resolves, and null when none resolve", async () => {
    const seedOnly = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 31,
      getNativePalette: async () => ({ system_accent1_500: 0xff0f5d42 }),
    }));
    expect(await seedOnly()).toEqual({ _tag: "Seed", seed: "#0F5D42" });

    const broken = makeAndroidDynamicColorReader(() => ({
      os: "android",
      version: 33,
      getNativePalette: () => {
        throw new Error("unsupported");
      },
    }));
    expect(await broken()).toBeNull();
  });
});
