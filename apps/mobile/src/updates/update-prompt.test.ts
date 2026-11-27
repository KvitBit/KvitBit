import { describe, expect, test } from "bun:test";
import { nextReadyUpdate, selectUpdatePrompt } from "./update-prompt";

const update = (updateId: string) => ({ kind: "update", updateId }) as const;
const embedded = { kind: "embedded" } as const;

describe("selectUpdatePrompt", () => {
  test("shows nothing while no update is ready", () => {
    expect(
      selectUpdatePrompt({ readyUpdate: undefined, runsEmbeddedUpdate: true }),
    ).toBeUndefined();
  });

  test("offers a reload for a downloaded update", () => {
    expect(selectUpdatePrompt({ readyUpdate: update("a"), runsEmbeddedUpdate: true })).toEqual({
      kind: "ota-update",
      updateId: "a",
    });
  });

  test("offers a reload into the embedded update after a rollback while an update runs", () => {
    expect(selectUpdatePrompt({ readyUpdate: embedded, runsEmbeddedUpdate: false })).toEqual({
      kind: "roll-back",
    });
  });

  test("offers nothing after a rollback when the app already runs its embedded update", () => {
    expect(selectUpdatePrompt({ readyUpdate: embedded, runsEmbeddedUpdate: true })).toBeUndefined();
  });
});

describe("nextReadyUpdate", () => {
  test("keeps a ready update through a later empty or failed check", () => {
    expect(nextReadyUpdate(update("a"), undefined)).toEqual(update("a"));
  });

  test("a newer update or rollback replaces the ready one", () => {
    expect(nextReadyUpdate(update("a"), update("b"))).toEqual(update("b"));
    expect(nextReadyUpdate(update("a"), embedded)).toEqual(embedded);
  });
});
