import { describe, expect, test } from "bun:test";
import type { AppStateStatus } from "react-native";
import {
  type AppStateSource,
  isUpdateCheckDue,
  otaUpdatesApply,
  scheduleUpdateChecks,
  updateCheckIntervalMs,
} from "./update-check";

const minutes = (count: number) => count * 60 * 1000;

describe("isUpdateCheckDue", () => {
  test("waits fifteen minutes between checks", () => {
    expect(updateCheckIntervalMs).toBe(minutes(15));
    expect(isUpdateCheckDue(0, minutes(15) - 1)).toBe(false);
    expect(isUpdateCheckDue(0, minutes(15))).toBe(true);
  });

  test("checks again when the clock moved back behind the last check", () => {
    expect(isUpdateCheckDue(minutes(30), minutes(10))).toBe(true);
  });
});

describe("otaUpdatesApply", () => {
  test("applies on native release builds with expo-updates enabled", () => {
    expect(otaUpdatesApply({ platform: "android", updatesEnabled: true, dev: false })).toBe(true);
    expect(otaUpdatesApply({ platform: "ios", updatesEnabled: true, dev: false })).toBe(true);
  });

  test("never applies on web, in dev or with expo-updates disabled", () => {
    expect(otaUpdatesApply({ platform: "web", updatesEnabled: true, dev: false })).toBe(false);
    expect(otaUpdatesApply({ platform: "android", updatesEnabled: true, dev: true })).toBe(false);
    expect(otaUpdatesApply({ platform: "android", updatesEnabled: false, dev: false })).toBe(false);
  });
});

const fakeAppState = () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const appState: AppStateSource = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return {
    appState,
    emit: (state: AppStateStatus) => {
      for (const listener of listeners) listener(state);
    },
    listening: () => listeners.size,
  };
};

const schedule = () => {
  const source = fakeAppState();
  const clock = { now: 0 };
  let checks = 0;
  const stop = scheduleUpdateChecks({
    appState: source.appState,
    now: () => clock.now,
    check: () => {
      checks += 1;
    },
  });
  return { ...source, clock, checks: () => checks, stop };
};

describe("scheduleUpdateChecks", () => {
  test("checks on launch", () => {
    expect(schedule().checks()).toBe(1);
  });

  test("waits fifteen minutes after launch before checking on a return", () => {
    const s = schedule();
    s.clock.now = minutes(14);
    s.emit("active");
    expect(s.checks()).toBe(1);
    s.clock.now = minutes(15);
    s.emit("active");
    expect(s.checks()).toBe(2);
    s.clock.now = minutes(20);
    s.emit("active");
    expect(s.checks()).toBe(2);
  });

  test("checks only when the app becomes active", () => {
    const s = schedule();
    s.clock.now = minutes(60);
    s.emit("background");
    s.emit("inactive");
    expect(s.checks()).toBe(1);
    s.emit("active");
    expect(s.checks()).toBe(2);
  });

  test("checks nothing once stopped", () => {
    const s = schedule();
    s.stop();
    expect(s.listening()).toBe(0);
    s.clock.now = minutes(60);
    s.emit("active");
    expect(s.checks()).toBe(1);
  });
});
