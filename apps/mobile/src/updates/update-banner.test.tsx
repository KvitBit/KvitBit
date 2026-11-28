import { describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { ReactElement } from "react";
import { expoUpdatesStandIn } from "./expo-updates-stand-in";
import type { ReadyUpdate } from "./ota-update";

mock.module("expo-updates", () => expoUpdatesStandIn);

// Imported after the mock, so they link the stand-in in place of expo-updates.
const { allText, find, hostTree } = await import("../testing/element-tree");
const { TestProviders } = await import("../testing/providers");
const { UpdateBanner } = await import("./index");
const { UpdateBannerView } = await import("./update-banner");
const { startUpdateChecks } = await import("./use-update-prompt");

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

describe("UpdateBannerView", () => {
  test("shows nothing while no update is ready", () => {
    expect(
      hostTree(<UpdateBannerView prompt={undefined} onReload={() => undefined} />, within),
    ).toBeNull();
  });

  test("offers a reload for a downloaded update", () => {
    let reloads = 0;
    const tree = hostTree(
      <UpdateBannerView
        prompt={{ kind: "ota-update", updateId: "a" }}
        onReload={() => reloads++}
      />,
      within,
    );
    expect(allText(tree)).toContain("A new version is available.");
    expect(allText(tree)).toContain("Reload");
    find<{ onPress: () => void }>(tree, "Pressable")?.props.onPress();
    expect(reloads).toBe(1);
  });

  test("speaks Czech under the Czech locale", () => {
    const tree = hostTree(
      <UpdateBannerView prompt={{ kind: "roll-back" }} onReload={() => undefined} />,
      (node) => <TestProviders locale="cs">{node}</TestProviders>,
    );
    expect(allText(tree)).toContain("Je k dispozici nová verze.");
    expect(allText(tree)).toContain("Načíst znovu");
  });
});

describe("UpdateBanner", () => {
  test("renders nothing before a check has found an update", () => {
    expect(hostTree(<UpdateBanner />, within)).toBeNull();
  });
});

type Updates = Parameters<typeof startUpdateChecks>[0]["updates"];
const availableUpdates = (calls: { check: number }): Updates => ({
  isEnabled: true,
  checkForUpdateAsync: () => {
    calls.check += 1;
    return Promise.resolve({
      isAvailable: true,
      isRollBackToEmbedded: false,
    });
  },
  fetchUpdateAsync: () =>
    Promise.resolve({ isNew: true, isRollBackToEmbedded: false, manifest: { id: "a" } }),
});

const inertAppState = { addEventListener: () => ({ remove: () => undefined }) };

const start = (platform: string, updates: Updates, dev = false) =>
  Effect.runPromise(
    Effect.callback<ReadyUpdate | undefined>((resolve) => {
      const stop = startUpdateChecks({
        platform,
        updates,
        dev,
        appState: inertAppState,
        now: () => 0,
        onCheck: (found) => resolve(Effect.succeed(found)),
      });
      return Effect.sync(stop);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "50 millis",
        orElse: () => Effect.succeed("no check" as const),
      }),
    ),
  );

describe("startUpdateChecks", () => {
  test("checks on launch and reports the downloaded update", async () => {
    const calls = { check: 0 };
    expect(await start("android", availableUpdates(calls))).toEqual({
      kind: "update",
      updateId: "a",
    });
    expect(calls.check).toBe(1);
  });

  test("checks nothing on web, in dev or with expo-updates disabled", async () => {
    const calls = { check: 0 };
    expect(await start("web", availableUpdates(calls))).toBe("no check");
    expect(await start("ios", availableUpdates(calls), true)).toBe("no check");
    expect(await start("ios", { ...availableUpdates(calls), isEnabled: false })).toBe("no check");
    expect(calls.check).toBe(0);
  });

  test("a failing check reports nothing and doesn't throw", async () => {
    const failing: Updates = {
      ...availableUpdates({ check: 0 }),
      checkForUpdateAsync: () => Promise.reject(new Error("offline")),
    };
    expect(await start("android", failing)).toBeUndefined();
  });
});
