import { describe, expect, test } from "bun:test";
import {
  enumText,
  fallbackPluralCategory,
  interpolate,
  issueKey,
  issueText,
  message,
  negotiateLocale,
  parseAcceptLanguage,
  pluralCategory,
  t,
  translate,
  translator,
} from "../../src/i18n";
import { text } from "../../src/text";

describe("plural rules", () => {
  test("Czech one/few/many/other", () => {
    expect([1, 2, 4, 5, 0, 22, 1.5].map((n) => pluralCategory("cs", n))).toEqual([
      "one",
      "few",
      "few",
      "other",
      "other",
      "other",
      "many",
    ]);
  });

  test("Czech plural messages pick the right form", () => {
    expect(t("cs", "common.time.days", { count: 1 })).toBe("1 den");
    expect(t("cs", "common.time.days", { count: 3 })).toBe("3 dny");
    expect(t("cs", "common.time.days", { count: 5 })).toBe("5 dní");
    expect(t("cs", "common.time.days", { count: 1.5 })).toBe("1,5 dne");
    expect(t("cs", "dashboard.tile.countInvoices", { count: 0 })).toBe("0 faktur");
  });

  test("English plural messages", () => {
    expect(t("en", "common.time.days", { count: 1 })).toBe("1 day");
    expect(t("en", "common.time.days", { count: 2 })).toBe("2 days");
    expect(t("en", "documents.share.views", { count: 0 })).toBe("0 views");
  });

  test("numbers in params use locale grouping", () => {
    expect(t("cs", "common.state.resultsCount", { count: 12345 })).toBe("12\u00a0345 výsledků");
    expect(t("en", "common.state.resultsCount", { count: 12345 })).toBe("12,345 results");
    expect(t("cs", "common.state.resultsCount", { count: 1234 })).toBe("1234 výsledků");
    expect(t("en", "public.footer.copyright", { year: 2026 })).toBe("© 2026 Kvitbit");
  });

  test("plural selection follows the displayed value", () => {
    expect(t("cs", "common.time.days", { count: 1.0000001 })).toBe("1 den");
    expect(t("en", "common.time.days", { count: 0.9999999 })).toBe("1 day");
  });

  test("the PluralRules fallback agrees with Intl for cs and en", () => {
    for (const locale of ["cs", "en"] as const) {
      for (const n of [0, 1, 2, 3, 4, 5, 11, 21, 22, 100, 101, 1.5, 0.5, 2.25]) {
        expect(fallbackPluralCategory(locale, n)).toBe(pluralCategory(locale, n));
      }
    }
  });
});

describe("translate", () => {
  test("interpolates named params", () => {
    expect(t("en", "documents.send.sent", { email: "a@b.cz" })).toBe("Email sent to a@b.cz");
    expect(t("cs", "error.rateLimited", { seconds: 30 })).toBe(
      "Příliš mnoho pokusů. Zkuste to znovu za 30 s.",
    );
  });

  test("resolves Text descriptors from any area", () => {
    expect(translate("cs", text("enum.badge.overdue"))).toBe("Po splatnosti");
    expect(translate("en", message("issue.ico.checksum"))).toBe(
      "This IČO is not valid. Check the digits.",
    );
    expect(translate("cs", enumText("documentKind", "proforma"))).toBe("Zálohová faktura");
  });

  test("unknown keys render as the key, missing params stay visible", () => {
    expect(translate("cs", text("nope.missing"))).toBe("nope.missing");
    expect(translate("en", text("documents.send.sent"))).toBe("Email sent to {email}");
  });

  test("plural without count falls back to other", () => {
    expect(translate("en", text("common.time.days"))).toBe("{count} days");
  });

  test("issue helpers map codes to issue.* keys and keep server params", () => {
    expect(issueKey("form.required")).toBe("issue.form.required");
    expect(issueText({ code: "form.too_long", params: { max: "80" } })).toEqual({
      key: "issue.form.too_long",
      params: { max: "80" },
    });
    expect(translate("cs", issueText({ code: "form.too_long", params: { max: "80" } }))).toBe(
      "Použijte nejvýše 80 znaků.",
    );
  });

  test("translator binds a locale", () => {
    const tr = translator("en");
    expect(tr.t("common.action.save")).toBe("Save");
    expect(tr.translate(text("common.action.cancel"))).toBe("Cancel");
  });

  test("interpolate leaves non-placeholder braces alone", () => {
    expect(interpolate("en", "{ x } {1} {a}", { a: "A" })).toBe("{ x } {1} A");
  });

  test("typed params are enforced at compile time", () => {
    // @ts-expect-error missing required params
    expect(t("en", "documents.send.sent")).toBe("Email sent to {email}");
    // @ts-expect-error key outside the catalog
    expect(t("en", "documents.nope")).toBe("documents.nope");
    // @ts-expect-error count must be a number
    t("en", "common.time.days", { count: "2" });
    expect(message("common.action.save")).toEqual({ key: "common.action.save" });
  });
});

describe("locale negotiation", () => {
  test("first supported candidate wins; Slovak reads Czech", () => {
    expect(negotiateLocale(["de-DE", "en-US", "cs"])).toBe("en");
    expect(negotiateLocale(["sk-SK"])).toBe("cs");
    expect(negotiateLocale([undefined, null, "fr"])).toBe("cs");
    expect(negotiateLocale(["fr"], "en")).toBe("en");
  });

  test("Accept-Language ordering by quality", () => {
    expect(parseAcceptLanguage("de;q=0.5, en-GB;q=0.8, cs-CZ, *;q=0.1, fr;q=0")).toEqual([
      "cs-CZ",
      "en-GB",
      "de",
    ]);
    expect(negotiateLocale(parseAcceptLanguage("de, en;q=0.9"))).toBe("en");
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });
});
