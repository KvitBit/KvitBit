import { describe, expect, test } from "bun:test";
import type { ContactDefaults, ReminderPolicy } from "@kvitbit/domain/contract";
import { CurrencyCode, NumberingSeriesId } from "@kvitbit/domain/contract";
import type {
  EffectiveReminders,
  RemindersChoice,
  WorkspaceBillingDefaults,
  WorkspaceReminderPolicy,
} from "../src/shared/overrides";
import {
  mergeSeriesByKind,
  resolveDocumentDefaults,
  resolveReminders,
} from "../src/shared/overrides";

const s = (n: number) => NumberingSeriesId.make(`01900000-0000-7000-8000-00000000500${n}`);
const CZK = CurrencyCode.make("CZK");
const EUR = CurrencyCode.make("EUR");
const USD = CurrencyCode.make("USD");

const workspace: WorkspaceBillingDefaults = {
  currency: CZK,
  language: "cs",
  dueDays: 14,
  paymentMethod: "bank_transfer",
  seriesByKind: { invoice: s(1), proforma: s(2), credit_note: s(3) },
  defaultNote: null,
};

describe("resolveDocumentDefaults: Document → Contact → Workspace", () => {
  test("Workspace defaults when nothing overrides", () => {
    expect(resolveDocumentDefaults({ kind: "invoice", workspace })).toEqual({
      currency: CZK,
      language: "cs",
      dueDays: 14,
      paymentMethod: "bank_transfer",
      series: s(1),
      note: null,
    });
  });

  test("Contact overrides the Workspace", () => {
    const contact: ContactDefaults = {
      currency: EUR,
      language: "en",
      dueDays: 30,
      paymentMethod: "card",
      defaultNote: "Thanks",
      preferredSeriesByKind: { invoice: s(7) },
    };
    expect(resolveDocumentDefaults({ kind: "invoice", contact, workspace })).toEqual({
      currency: EUR,
      language: "en",
      dueDays: 30,
      paymentMethod: "card",
      series: s(7),
      note: "Thanks",
    });
  });

  test("Document overrides the Contact", () => {
    const contact: ContactDefaults = { currency: EUR, dueDays: 30, defaultNote: "Contact note" };
    const resolved = resolveDocumentDefaults({
      kind: "invoice",
      document: { currency: USD, dueDays: 0, note: "", series: s(9), paymentMethod: "cash" },
      contact,
      workspace,
    });
    expect(resolved).toEqual({
      currency: USD,
      language: "cs",
      dueDays: 0, // 0 is a value, not "unset"
      paymentMethod: "cash",
      series: s(9),
      note: "",
    });
  });

  test("a kind the Contact map leaves out uses the Workspace series", () => {
    const contact: ContactDefaults = { preferredSeriesByKind: { invoice: s(7) } };
    expect(resolveDocumentDefaults({ kind: "proforma", contact, workspace }).series).toBe(s(2));
    expect(
      resolveDocumentDefaults({ kind: "payment_tax_document", contact, workspace }).series,
    ).toBeNull();
  });

  test("mergeSeriesByKind merges the partial Contact map per kind", () => {
    expect(
      mergeSeriesByKind({ proforma: s(8), payment_tax_document: s(9) }, workspace.seriesByKind),
    ).toEqual({ invoice: s(1), proforma: s(8), credit_note: s(3), payment_tax_document: s(9) });
    expect(mergeSeriesByKind({}, workspace.seriesByKind)).toEqual(workspace.seriesByKind);
    expect(mergeSeriesByKind(undefined, workspace.seriesByKind)).toEqual(workspace.seriesByKind);
  });
});

describe("resolveReminders (rule D16)", () => {
  const on: WorkspaceReminderPolicy = { enabled: true, proformas: true, offsetsDays: [3, 14] };
  const off: WorkspaceReminderPolicy = { enabled: false, proformas: true, offsetsDays: [3, 14] };
  const noProformas: WorkspaceReminderPolicy = {
    enabled: true,
    proformas: false,
    offsetsDays: [3, 14],
  };
  const custom: ReminderPolicy = { mode: "custom", offsetsDays: [7, 21] };
  const disabled: ReminderPolicy = { mode: "disabled" };
  const inherit: ReminderPolicy = { mode: "inherit" };
  const none: EffectiveReminders = { arms: false, offsetsDays: [] };
  const ws = { arms: true, offsetsDays: [3, 14] };
  const own = { arms: true, offsetsDays: [7, 21] };

  const cases: ReadonlyArray<
    readonly [
      RemindersChoice,
      ReminderPolicy | undefined,
      WorkspaceReminderPolicy,
      EffectiveReminders,
    ]
  > = [
    ["off", custom, on, none],
    ["off", undefined, on, none],
    ["inherit", custom, off, own],
    ["on", custom, on, own],
    ["inherit", disabled, on, none],
    ["on", disabled, off, ws],
    ["inherit", inherit, on, ws],
    ["inherit", undefined, on, ws],
    ["inherit", inherit, off, none],
    ["on", inherit, off, ws],
    ["on", undefined, off, ws],
  ];
  for (const [choice, contact, workspacePolicy, expected] of cases) {
    test(`invoice: choice ${choice}, contact ${contact?.mode ?? "absent"}, workspace ${workspacePolicy.enabled ? "on" : "off"}`, () => {
      expect(
        resolveReminders({ kind: "invoice", choice, contact, workspace: workspacePolicy }),
      ).toEqual(expected);
    });
  }

  test("an inherited Proforma follows the Workspace Proforma setting", () => {
    expect(
      resolveReminders({ kind: "proforma", choice: "inherit", workspace: noProformas }),
    ).toEqual(none);
    expect(resolveReminders({ kind: "proforma", choice: "inherit", workspace: on })).toEqual(ws);
    expect(
      resolveReminders({ kind: "invoice", choice: "inherit", workspace: noProformas }),
    ).toEqual(ws);
    expect(resolveReminders({ kind: "proforma", choice: "on", workspace: noProformas })).toEqual(
      ws,
    );
  });

  test("only Invoices and Proformas are reminded", () => {
    for (const kind of ["credit_note", "payment_tax_document"] as const) {
      expect(resolveReminders({ kind, choice: "on", contact: custom, workspace: on })).toEqual(
        none,
      );
    }
  });

  test("empty offsets arm nothing", () => {
    expect(
      resolveReminders({
        kind: "invoice",
        choice: "inherit",
        contact: { mode: "custom", offsetsDays: [] },
        workspace: on,
      }),
    ).toEqual(none);
  });
});
