import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ThemeWarning, UnauthorizedReason } from "@kvitbit/api-contract";
import {
  ConflictReason,
  DeliveryStatus,
  DocumentKind,
  DocumentRelation,
  DocumentSettlement,
  DocumentStatus,
  EntityKind,
  ExpenseStatus,
  InvitationStatus,
  IssueCode,
  Locale,
  PaymentMethod,
  PdfTemplate,
  ReportKind,
  Role,
  SCOPE_AREAS,
  ScopeLevel,
  TaxRegime,
  ThemeContrast,
  ThemeMode,
  ThemePresetId,
  ThemeStyle,
  UnavailableDependency,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { cs, en, enSections, isMessageKey, MESSAGE_KEYS, UI_ISSUE_CODES } from "../../src/i18n";
import type { AnyMessage } from "../../src/i18n/types";

const forms = (m: AnyMessage): ReadonlyArray<string> =>
  typeof m === "string" ? [m] : Object.values(m).filter((v): v is string => v !== undefined);

const placeholders = (m: AnyMessage): ReadonlyArray<string> =>
  [
    ...new Set(forms(m).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((x) => x[1] ?? ""))),
  ].sort();

const csRecord: Readonly<Record<string, AnyMessage>> = cs;
const enRecord: Readonly<Record<string, AnyMessage>> = en;

describe("catalog parity", () => {
  test("cs and en have exactly the same keys", () => {
    const enKeys = Object.keys(en);
    const csKeys = Object.keys(cs);
    expect(csKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in cs))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(900);
  });

  test("no key is defined in two sections (spread would hide it)", () => {
    const total = Object.values(enSections).reduce((n, s) => n + Object.keys(s).length, 0);
    expect(total).toBe(MESSAGE_KEYS.length);
  });

  test("every key has identical placeholders in cs and en", () => {
    const mismatches = MESSAGE_KEYS.filter(
      (k) => placeholders(enRecord[k] ?? "").join() !== placeholders(csRecord[k] ?? "").join(),
    );
    expect(mismatches).toEqual([]);
  });

  test("plural messages: en one/other, cs one/few/many/other, all with {count}", () => {
    for (const key of MESSAGE_KEYS) {
      const e = enRecord[key];
      const c = csRecord[key];
      if (typeof e === "string") {
        expect(typeof c).toBe("string");
        continue;
      }
      expect(Object.keys(e ?? {}).sort()).toEqual(["one", "other"]);
      expect(Object.keys(c ?? {}).sort()).toEqual(["few", "many", "one", "other"]);
      for (const f of [...forms(e ?? ""), ...forms(c ?? "")]) expect(f).toContain("{count}");
    }
  });

  test("no empty copy and keys are dotted", () => {
    for (const key of MESSAGE_KEYS) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/);
      for (const f of [...forms(enRecord[key] ?? ""), ...forms(csRecord[key] ?? "")]) {
        expect(f.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("Czech copy is actually Czech: diacritics present across the catalog", () => {
    const text = Object.values(csRecord).flatMap(forms).join(" ");
    for (const ch of "áčďéěíňóřšťúůýž") expect(text).toContain(ch);
  });
});

/** Issue codes the api-contract package emits literally (`code: "x.y"`), read from its source. */
const apiContractIssueCodes = (): ReadonlyArray<string> => {
  const root = join(import.meta.dir, "../../../api-contract/src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".ts"),
  );
  return files.flatMap((f) =>
    [...readFileSync(join(root, f), "utf8").matchAll(/code: "([a-z_]+\.[a-z_]+)"/g)].map(
      (m) => m[1] ?? "",
    ),
  );
};

describe("issue and error coverage", () => {
  test("every domain IssueCode has issue.<code>", () => {
    const missing = IssueCode.literals.filter((c) => !isMessageKey(`issue.${c}`));
    expect(IssueCode.literals.length).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  test("every api-contract issue code (ThemeWarning, literal codes) has issue.<code>", () => {
    const codes = [...ThemeWarning.literals, ...apiContractIssueCodes()];
    expect(codes).toContain("request.malformed");
    expect(codes.filter((c) => !isMessageKey(`issue.${c}`))).toEqual([]);
  });

  test("every UI-only issue code has issue.<code> and every issue.* key is a known code", () => {
    expect(UI_ISSUE_CODES.filter((c) => !isMessageKey(`issue.${c}`))).toEqual([]);
    const known = new Set<string>([...IssueCode.literals, ...UI_ISSUE_CODES]);
    const orphans = MESSAGE_KEYS.filter((k) => k.startsWith("issue.")).filter(
      (k) => !known.has(k.slice("issue.".length)),
    );
    expect(orphans).toEqual([]);
  });

  test("error copy exists for every edge and core error variant", () => {
    const keys = [
      ...UnauthorizedReason.literals.map((r) => `error.unauthorized.${r}`),
      ...ConflictReason.literals.map((r) => `error.conflict.${r}`),
      ...UnavailableDependency.literals.map((d) => `error.unavailable.${d}`),
      ...EntityKind.literals.map((e) => `enum.entity.${e}`),
      "error.invalidBotProof",
      "error.originRejected",
      "error.preconditionFailed",
      "error.preconditionRequired",
      "error.payloadTooLarge",
      "error.rateLimited",
      "error.notFound",
      "error.forbidden",
      "error.invalid",
      "error.network",
      "error.offline",
      "error.timeout",
      "error.cancelled",
      "error.unknown",
    ];
    expect(keys.filter((k) => !isMessageKey(k))).toEqual([]);
  });
});

describe("enum labels follow the domain unions", () => {
  const unions: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["documentKind", DocumentKind.literals],
    ["documentKindPlural", DocumentKind.literals],
    ["documentStatus", DocumentStatus.literals],
    ["settlement", DocumentSettlement.literals],
    ["documentRelation", DocumentRelation.literals],
    ["paymentMethod", PaymentMethod.literals],
    ["vatTreatment", VatTreatment.literals],
    ["taxRegime", TaxRegime.literals],
    ["taxRegimeHint", TaxRegime.literals],
    ["role", Role.literals],
    ["invitationStatus", InvitationStatus.literals],
    ["scopeArea", SCOPE_AREAS],
    ["scopeLevel", ScopeLevel.literals],
    ["themePreset", ThemePresetId.literals],
    ["themeStyle", ThemeStyle.literals],
    ["themeMode", ThemeMode.literals],
    ["themeContrast", ThemeContrast.literals],
    ["locale", Locale.literals],
    ["reportKind", ReportKind.literals],
    ["pdfTemplate", PdfTemplate.literals],
    ["deliveryStatus", DeliveryStatus.literals],
    ["expenseStatus", ExpenseStatus.literals],
    ["entity", EntityKind.literals],
  ];
  for (const [name, values] of unions) {
    test(`enum.${name}.* covers every value`, () => {
      expect(values.filter((v) => !isMessageKey(`enum.${name}.${v}`))).toEqual([]);
    });
  }

  test("theme preset names match the product naming", () => {
    expect(en["enum.themePreset.graphite_atelier"]).toBe("Graphite Atelier");
    expect(en["enum.themePreset.forest"]).toBe("Banknote Emerald");
    expect(en["enum.themePreset.sand"]).toBe("Prague Ledger");
    expect(en["enum.themePreset.graphite"]).toBe("Pure Graphite");
  });

  test("Czech accounting terms", () => {
    expect(cs["enum.documentKind.proforma"]).toBe("Zálohová faktura");
    expect(cs["enum.documentKind.credit_note"]).toBe("Opravný daňový doklad");
    expect(cs["enum.documentKind.payment_tax_document"]).toBe("Daňový doklad k přijaté platbě");
    expect(cs["enum.taxRegime.non_vat_payer"]).toBe("Neplátce DPH");
    expect(cs["contacts.override.inherited"]).toBe("Převzato z pracovního prostoru");
    expect(cs["contacts.override.overridden"]).toBe("Přepsáno");
  });
});
