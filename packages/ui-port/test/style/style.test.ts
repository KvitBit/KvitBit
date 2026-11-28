import { describe, expect, test } from "bun:test";
import { EXTENDED_ROLES, M3_COLOR_ROLES } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import {
  cn,
  cva,
  TAILWIND_COLOR_TOKENS,
  TAILWIND_FONT_TOKENS,
  TAILWIND_RADIUS_TOKENS,
  uniwindThemeVariables,
} from "../../src/style";
import { effectiveTheme, initialThemeState } from "../../src/theme";

describe("@kvitbit/ui-port/style", () => {
  test("cn merges conflicting Tailwind utilities including custom Kvitbit tokens", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("rounded-control", "rounded-panel")).toBe("rounded-panel");
    expect(cn("bg-surface", "bg-primary-container")).toBe("bg-primary-container");
    expect(cn("text-sm text-on-surface", "text-error")).toBe("text-sm text-error");
    expect(cn("font-body", "font-mono")).toBe("font-mono");
    expect(cn("flex", false, undefined, null, "gap-2")).toBe("flex gap-2");
  });

  test("cva composes typed component variants with cn overrides", () => {
    const badge = cva("inline-flex items-center rounded-badge", {
      variants: {
        tone: {
          neutral: "bg-surface-container-high text-on-surface-variant",
          paid: "bg-paid-container text-on-paid-container",
        },
      },
      defaultVariants: { tone: "neutral" },
    });
    expect(cn(badge({ tone: "paid" }), "bg-error-container")).toBe(
      "inline-flex items-center rounded-badge text-on-paid-container bg-error-container",
    );
  });

  test("declares every M3 role, extended financial role, radius and font token", () => {
    const names = new Set(Arr.map(TAILWIND_COLOR_TOKENS, (t) => t.tailwindVar));
    expect(TAILWIND_COLOR_TOKENS.length).toBe(M3_COLOR_ROLES.length + EXTENDED_ROLES.length * 4);
    expect(names.has("--color-surface")).toBe(true);
    expect(names.has("--color-surface-container-lowest")).toBe(true);
    expect(names.has("--color-paid-container")).toBe(true);
    expect(names.has("--color-on-overdue-container")).toBe(true);
    expect(Arr.map(TAILWIND_RADIUS_TOKENS, (t) => t.tailwindVar)).toEqual([
      "--radius-panel",
      "--radius-control",
      "--radius-badge",
    ]);
    expect(Arr.map(TAILWIND_FONT_TOKENS, (t) => t.tailwindVar)).toEqual([
      "--font-display",
      "--font-body",
      "--font-mono",
    ]);
  });

  test("uniwindThemeVariables emits all runtime color and radius variables for active theme", () => {
    const base = initialThemeState({ scheme: "light" });
    const theme = effectiveTheme({
      ...base,
      preference: { ...base.preference, style: "cozy" },
    });
    const vars = uniwindThemeVariables(theme);
    expect(vars["--color-surface"]).toBe(theme.roles.surface);
    expect(vars["--color-primary"]).toBe(theme.roles.primary);
    expect(vars["--color-paid-container"]).toBe(theme.extended.paid.colorContainer);
    expect(vars["--radius-panel"]).toBe("12px");
    expect(vars["--radius-control"]).toBe("8px");
    expect(vars["--radius-badge"]).toBe("9999px");
  });
});
