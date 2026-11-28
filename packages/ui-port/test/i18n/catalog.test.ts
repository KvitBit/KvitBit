import { describe, expect, test } from "bun:test";
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
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { cs, en, enSections, isMessageKey, MESSAGE_KEYS, UI_ISSUE_CODES } from "../../src/i18n";
import type { AnyMessage } from "../../src/i18n/types";

const REMAINING_BRACE = /[{}]/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const DOTTED_KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const forms = (m: AnyMessage): ReadonlyArray<string> =>
  Predicate.isString(m)
    ? [m]
    : Arr.filter(Rec.values<string, string | undefined>(m), Predicate.isNotUndefined);

const placeholders = (m: AnyMessage): ReadonlyArray<string> =>
  [
    ...new Set(
      Arr.flatMap(forms(m), (f) => Arr.map([...Str.matchAll(PLACEHOLDER)(f)], (x) => x[1] ?? "")),
    ),
  ].sort(Order.String);

const csRecord: Readonly<Record<string, AnyMessage>> = cs;
const enRecord: Readonly<Record<string, AnyMessage>> = en;

describe("catalog parity", () => {
  test("cs and en have exactly the same keys", () => {
    const enKeys = Rec.keys(en);
    const csKeys = Rec.keys(cs);
    expect(Arr.filter(csKeys, (k) => !(k in en))).toEqual([]);
    expect(Arr.filter(enKeys, (k) => !(k in cs))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(900);
  });

  test("no key is defined in two sections (spread would hide it)", () => {
    const total = Arr.reduce(
      Rec.values(enSections),
      0,
      (n, s) => n + Rec.keys<string, AnyMessage>(s).length,
    );
    expect(total).toBe(MESSAGE_KEYS.length);
  });

  test("every key has identical placeholders in cs and en", () => {
    const mismatches = Arr.filter(
      MESSAGE_KEYS,
      (k) =>
        Arr.join(placeholders(enRecord[k] ?? ""), ",") !==
        Arr.join(placeholders(csRecord[k] ?? ""), ","),
    );
    expect(mismatches).toEqual([]);
  });

  test("plural messages: en one/other, cs one/few/many/other, all with {count}", () => {
    for (const key of MESSAGE_KEYS) {
      const e = enRecord[key];
      const c = csRecord[key];
      expect(Predicate.isString(c)).toBe(Predicate.isString(e));
      if (Predicate.isString(e)) continue;
      expect(Rec.keys<string, string | undefined>(e ?? {}).sort(Order.String)).toEqual([
        "one",
        "other",
      ]);
      expect(
        Rec.keys<string, string | undefined>(Predicate.isObject(c) ? c : {}).sort(Order.String),
      ).toEqual(["few", "many", "one", "other"]);
      for (const f of [...forms(e ?? ""), ...forms(c ?? "")]) expect(f).toContain("{count}");
    }
  });

  test("braces only appear as well-formed placeholders (types and runtime parse the same)", () => {
    const stray = Arr.filter(MESSAGE_KEYS, (k) =>
      Arr.some([...forms(enRecord[k] ?? ""), ...forms(csRecord[k] ?? "")], (f) =>
        REMAINING_BRACE.test(Str.replace(PLACEHOLDER, "")(f)),
      ),
    );
    expect(stray).toEqual([]);
  });

  test("no empty copy and keys are dotted", () => {
    for (const key of MESSAGE_KEYS) {
      expect(key).toMatch(DOTTED_KEY);
      for (const f of [...forms(enRecord[key] ?? ""), ...forms(csRecord[key] ?? "")]) {
        expect(Str.trim(f).length).toBeGreaterThan(0);
      }
    }
  });

  test("Czech copy is actually Czech: diacritics present across the catalog", () => {
    const text = Arr.join(Arr.flatMap(Rec.values(csRecord), forms), " ");
    for (const ch of "áčďéěíňóřšťúůýž") expect(text).toContain(ch);
  });
});

/** Issue codes the api-contract package emits literally (`code: "x.y"`), read from its source. */
const ISSUE_CODE_LITERAL = /code: "([a-z_]+\.[a-z_]+)"/g;
const apiContractIssueCodes = (): Promise<ReadonlyArray<string>> => {
  const root = new URL("../../../api-contract/src/", import.meta.url);
  const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: Bun.fileURLToPath(root) })];
  return Promise.all(Arr.map(files, (file) => Bun.file(new URL(file, root)).text())).then(
    (sources) =>
      Arr.flatMap(sources, (source) =>
        Arr.map([...Str.matchAll(ISSUE_CODE_LITERAL)(source)], (match) => match[1] ?? ""),
      ),
  );
};

describe("issue and error coverage", () => {
  test("every domain IssueCode has issue.<code>", () => {
    const missing = Arr.filter(IssueCode.literals, (c) => !isMessageKey(`issue.${c}`));
    expect(IssueCode.literals.length).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  test("every api-contract issue code (ThemeWarning, literal codes) has issue.<code>", async () => {
    const codes = [...ThemeWarning.literals, ...(await apiContractIssueCodes())];
    expect(codes).toContain("request.malformed");
    expect(Arr.filter(codes, (c) => !isMessageKey(`issue.${c}`))).toEqual([]);
  });

  test("every UI-only issue code has issue.<code> and every issue.* key is a known code", () => {
    expect(Arr.filter(UI_ISSUE_CODES, (c) => !isMessageKey(`issue.${c}`))).toEqual([]);
    const known = new Set<string>([...IssueCode.literals, ...UI_ISSUE_CODES]);
    const orphans = Arr.filter(
      Arr.filter(MESSAGE_KEYS, (k) => Fn.pipe(k, Str.startsWith("issue."))),
      (k) => !known.has(Fn.pipe(k, Str.slice("issue.".length))),
    );
    expect(orphans).toEqual([]);
  });

  test("error copy exists for every edge and core error variant", () => {
    const keys = [
      ...Arr.map(UnauthorizedReason.literals, (r) => `error.unauthorized.${r}`),
      ...Arr.map(ConflictReason.literals, (r) => `error.conflict.${r}`),
      ...Arr.map(UnavailableDependency.literals, (d) => `error.unavailable.${d}`),
      ...Arr.map(EntityKind.literals, (e) => `enum.entity.${e}`),
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
    expect(Arr.filter(keys, (k) => !isMessageKey(k))).toEqual([]);
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
      expect(Arr.filter(values, (v) => !isMessageKey(`enum.${name}.${v}`))).toEqual([]);
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
