import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { allText, find, hostTree } from "../testing/element-tree";
import { TestProviders } from "../testing/providers";
import { Button } from "./button";
import { Badge, ListRow } from "./surface";

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

describe("ui kit", () => {
  test("a list row shows title, subtitle and the amount", () => {
    const tree = hostTree(
      <ListRow title="Invoice 2026-0001" subtitle="Acme s.r.o." trailing="12 100,00 Kč" />,
      within,
    );
    const text = allText(tree);
    expect(text).toContain("Invoice 2026-0001");
    expect(text).toContain("12 100,00 Kč");
  });

  test("a badge renders its label", () => {
    expect(allText(hostTree(<Badge label="Paid" tone="success" />, within))).toBe("Paid");
  });

  test("a button presses unless busy", () => {
    let pressed = 0;
    const press = (busy: boolean) => {
      const tree = hostTree(<Button label="Save" busy={busy} onPress={() => pressed++} />, within);
      const pressable = find<{ disabled: boolean; onPress: () => void }>(tree, "Pressable");
      if (pressable !== undefined && !pressable.props.disabled) pressable.props.onPress();
    };
    press(false);
    press(true);
    expect(pressed).toBe(1);
  });
});
