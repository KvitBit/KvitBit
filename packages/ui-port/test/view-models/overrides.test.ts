import { describe, expect, test } from "bun:test";
import { CurrencyCode, NumberingSeriesId } from "@kvitbit/domain/contract";
import {
  OverrideForm,
  PRODUCT_DEFAULTS,
  resolveBilling,
  resolveReminders,
  resolveSetting,
} from "../../src/view-models";

const S1 = NumberingSeriesId.make("0193a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a61");
const S2 = NumberingSeriesId.make("0193a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a62");
const EUR = CurrencyCode.make("EUR");
const USD = CurrencyCode.make("USD");

describe("resolveSetting", () => {
  test("each layer wins over the ones below it", () => {
    expect(resolveSetting({ document: 1, contact: 2, workspace: 3, fallback: 4 })).toEqual({
      value: 1,
      source: "document",
      overridden: true,
      inherited: 2,
      inheritedSource: "contact",
    });
    expect(resolveSetting({ contact: 2, workspace: 3, fallback: 4 })).toMatchObject({
      value: 2,
      source: "contact",
      overridden: false,
      inherited: 2,
    });
    expect(resolveSetting({ workspace: 3, fallback: 4 })).toMatchObject({
      value: 3,
      source: "workspace",
    });
    expect(resolveSetting({ fallback: 4 })).toMatchObject({
      value: 4,
      source: "default",
      inheritedSource: "default",
    });
  });

  test("seen from the Contact level: own value is overridden, inherited is the Workspace's", () => {
    expect(resolveSetting({ contact: 10, workspace: 30, fallback: 14 }, "contact")).toEqual({
      value: 10,
      source: "contact",
      overridden: true,
      inherited: 30,
      inheritedSource: "workspace",
    });
    expect(resolveSetting({ document: 1, workspace: 30, fallback: 14 }, "contact")).toMatchObject({
      value: 30,
      source: "workspace",
      overridden: false,
    });
  });

  test("falsy values still count as set", () => {
    expect(resolveSetting({ document: 0, contact: 5, fallback: 14 }).value).toBe(0);
    expect(resolveSetting({ document: "", contact: "x", fallback: "y" }).source).toBe("document");
  });
});

describe("resolveBilling", () => {
  test("Document -> Contact -> Workspace -> product default per field", () => {
    const r = resolveBilling({
      kind: "invoice",
      document: { dueDays: 7 },
      contact: { currency: EUR, preferredSeriesByKind: { proforma: S2 } },
      workspace: { language: "en", seriesByKind: { invoice: S1, proforma: S1 } },
    });
    expect([r.dueDays.value, r.dueDays.source]).toEqual([7, "document"]);
    expect([r.currency.value, r.currency.source]).toEqual([EUR, "contact"]);
    expect([r.language.value, r.language.source]).toEqual(["en", "workspace"]);
    expect([r.paymentMethod.value, r.paymentMethod.source]).toEqual([
      PRODUCT_DEFAULTS.paymentMethod,
      "default",
    ]);
    // invoice is not in the Contact's partial series map: Workspace series
    expect([r.series.value, r.series.source]).toEqual([S1, "workspace"]);
    expect(
      resolveBilling({
        kind: "proforma",
        contact: { preferredSeriesByKind: { proforma: S2 } },
        workspace: {},
      }).series,
    ).toMatchObject({ value: S2, source: "contact" });
    expect(resolveBilling({ kind: "credit_note", workspace: {} }).series).toMatchObject({
      value: null,
      source: "default",
    });
  });
});

describe("resolveReminders", () => {
  test("inherit and absent follow the Workspace; disabled and custom are the Contact's", () => {
    expect(resolveReminders(undefined, [3, 10])).toMatchObject({
      value: [3, 10],
      source: "workspace",
    });
    expect(resolveReminders({ mode: "inherit" }, [3])).toMatchObject({
      value: [3],
      source: "workspace",
      overridden: false,
    });
    expect(resolveReminders({ mode: "disabled" }, [3])).toMatchObject({
      value: [],
      source: "contact",
      overridden: true,
      inherited: [3],
    });
    expect(resolveReminders({ mode: "custom", offsetsDays: [1, 7] }, [3])).toMatchObject({
      value: [1, 7],
      source: "contact",
    });
  });
});

describe("OverrideForm", () => {
  test("set, clear back to inherited and dirty tracking", () => {
    let f = OverrideForm.init({ currency: EUR, dueDays: 30 });
    expect(OverrideForm.isDirty(f)).toBe(false);
    f = OverrideForm.set(f, "currency", USD);
    expect(OverrideForm.dirtyFields(f)).toEqual(["currency"]);
    f = OverrideForm.set(f, "currency", EUR);
    expect(OverrideForm.isDirty(f)).toBe(false);
    f = OverrideForm.clear(f, "dueDays");
    expect(OverrideForm.isOverridden(f, "dueDays")).toBe(false);
    expect(OverrideForm.toInput(f)).toEqual({ currency: EUR });
    expect(OverrideForm.dirtyFields(f)).toEqual(["dueDays"]);
    const r = resolveBilling({
      kind: "invoice",
      contact: OverrideForm.toInput(f),
      workspace: { dueDays: 21 },
    });
    expect(r.dueDays).toMatchObject({ value: 21, source: "workspace" });
  });

  test("per-kind series: setting and clearing one kind, empty map is dropped", () => {
    let f = OverrideForm.init();
    f = OverrideForm.setSeries(f, "invoice", S1);
    f = OverrideForm.setSeries(f, "proforma", S2);
    expect(OverrideForm.toInput(f)).toEqual({
      preferredSeriesByKind: { invoice: S1, proforma: S2 },
    });
    f = OverrideForm.setSeries(f, "invoice", null);
    expect(OverrideForm.toInput(f)).toEqual({ preferredSeriesByKind: { proforma: S2 } });
    f = OverrideForm.setSeries(f, "proforma", null);
    expect(OverrideForm.toInput(f)).toEqual({});
    expect(OverrideForm.isDirty(f)).toBe(false);
  });

  test("reminder policy inherit equals absent", () => {
    let f = OverrideForm.init({ reminderPolicy: { mode: "inherit" } });
    expect(f.initial).toEqual({});
    f = OverrideForm.setReminderPolicy(f, { mode: "custom", offsetsDays: [5] });
    expect(OverrideForm.dirtyFields(f)).toEqual(["reminderPolicy"]);
    f = OverrideForm.setReminderPolicy(f, { mode: "inherit" });
    expect(OverrideForm.isDirty(f)).toBe(false);
    expect(OverrideForm.toInput(f)).toEqual({});
  });
});
