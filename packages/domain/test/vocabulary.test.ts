import { describe, expect, test } from "bun:test";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  ContactDefaults,
  CurrencyCode,
  DocumentKind,
  DocumentStatus,
  IsoDate,
  Money,
  PageRequest,
  ReminderPolicy,
  RequestKey,
  resolveDefault,
  ShareToken,
  TaxRegime,
  ThemePreference,
  ThemePresetId,
  ThemeSource,
  WorkspaceId,
  WorkspaceSlug,
} from "../src/index";

const accepts = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: Schema.Json,
) => Exit.isSuccess(Schema.decodeExit(schema)(input));

describe("WorkspaceSlug", () => {
  test.each(["abc", "my-firm-2", Str.repeat(40)("a"), "0ab"])("accepts %p", (slug) => {
    expect(accepts(WorkspaceSlug, slug)).toBe(true);
  });
  test.each([
    "ab", // too short
    Str.repeat(41)("a"), // too long
    "-abc",
    "abc-",
    "Abc",
    "a_bc",
    "ab c",
    "",
  ])("rejects %p", (slug) => {
    expect(accepts(WorkspaceSlug, slug)).toBe(false);
  });
});

describe("CurrencyCode and IsoDate", () => {
  test("brand constructors validate strings and return the same value", () => {
    const workspace = "0192f0c4-0000-7000-8000-000000000000";
    expect(String(WorkspaceId.make(workspace))).toBe(workspace);
    expect(String(CurrencyCode.make("CZK"))).toBe("CZK");
    expect(String(IsoDate.make("0000-02-29"))).toBe("0000-02-29");
    expect(() => WorkspaceId.make("not-an-id")).toThrow();
    expect(() => CurrencyCode.make("czk")).toThrow();
    expect(() => IsoDate.make("2026-02-29")).toThrow();
    expect(() => RequestKey.make("")).toThrow();
  });
  test("currency is three upper-case letters", () => {
    expect(accepts(CurrencyCode, "CZK")).toBe(true);
    expect(accepts(CurrencyCode, "czk")).toBe(false);
    expect(accepts(CurrencyCode, "CZKK")).toBe(false);
  });
  test("IsoDate is a real calendar day in YYYY-MM-DD", () => {
    expect(accepts(IsoDate, "2026-11-23")).toBe(true);
    expect(accepts(IsoDate, "2024-02-29")).toBe(true); // leap year
    expect(accepts(IsoDate, "0099-12-31")).toBe(true); // years below 100 keep their value
    expect(accepts(IsoDate, "0000-02-29")).toBe(true); // year 0 is a leap year (proleptic)
    expect(accepts(IsoDate, "0100-02-29")).toBe(false);
    expect(accepts(IsoDate, "2026-02-29")).toBe(false);
    expect(accepts(IsoDate, "2026-02-30")).toBe(false);
    expect(accepts(IsoDate, "2026-13-01")).toBe(false);
    expect(accepts(IsoDate, "2026-04-31")).toBe(false);
    expect(accepts(IsoDate, "2026-00-10")).toBe(false);
    expect(accepts(IsoDate, "2026-1-23")).toBe(false);
    expect(accepts(IsoDate, "2026-11-23T00:00:00Z")).toBe(false);
  });
  test("entity ids are UUIDv7", () => {
    expect(accepts(WorkspaceId, "0192f0c4-0000-7000-8000-000000000000")).toBe(true);
    expect(accepts(WorkspaceId, "0192F0C4-1B2C-7D3E-8F40-0123456789AB")).toBe(true);
    expect(accepts(WorkspaceId, "")).toBe(false);
    expect(accepts(WorkspaceId, "not-an-id")).toBe(false);
    expect(accepts(WorkspaceId, "0192f0c4-1b2c-4d3e-8f40-0123456789ab")).toBe(false); // v4
    expect(accepts(WorkspaceId, "0192f0c4-1b2c-7d3e-cf40-0123456789ab")).toBe(false); // variant
    expect(accepts(WorkspaceId, 42)).toBe(false);
  });
  test("tokens and retry keys keep their own formats but are non-empty", () => {
    expect(accepts(ShareToken, "v1.abc_DEF-123")).toBe(true);
    expect(accepts(RequestKey, "mcp:grant-1:retry-7")).toBe(true);
    expect(accepts(ShareToken, "")).toBe(false);
  });
});

describe("closed literal unions", () => {
  test("Czech tax regimes", () => {
    expect(TaxRegime.literals).toEqual(["non_vat_payer", "vat_payer", "identified_person"]);
  });
  test("document kinds and statuses", () => {
    expect(DocumentKind.literals).toEqual([
      "invoice",
      "proforma",
      "payment_tax_document",
      "credit_note",
    ]);
    expect(DocumentStatus.literals).toEqual(["draft", "issued", "cancelled"]);
    expect(accepts(DocumentStatus, "locked")).toBe(false);
  });
});

describe("PageRequest", () => {
  test("limit is an integer from 1 to 100", () => {
    expect(accepts(PageRequest, {})).toBe(true);
    expect(accepts(PageRequest, { limit: 1 })).toBe(true);
    expect(accepts(PageRequest, { limit: 100 })).toBe(true);
    expect(accepts(PageRequest, { limit: 0 })).toBe(false);
    expect(accepts(PageRequest, { limit: 101 })).toBe(false);
    expect(accepts(PageRequest, { limit: 2.5 })).toBe(false);
  });
});

describe("Money on the wire", () => {
  const json = Schema.toCodecJson(Money);
  test("amounts encode as decimal strings and round-trip", () => {
    const czk = CurrencyCode.make("CZK");
    const encoded = Schema.encodeEffect(json)({
      amount: BigDecimal.fromStringUnsafe("1210.50"),
      currency: czk,
    }).pipe(Effect.runSync);
    expect(encoded).toEqual({ amount: "1210.5", currency: "CZK" });
    const decoded = Schema.decodeEffect(json)(encoded).pipe(Effect.runSync);
    expect(BigDecimal.equals(decoded.amount, BigDecimal.fromStringUnsafe("1210.5"))).toBe(true);
  });
  test("encoding fails for a value that is not a BigDecimal", () => {
    expect(
      Schema.encodeUnknownExit(json)({ amount: "1.5", currency: "CZK" }).pipe(Exit.isFailure),
    ).toBe(true);
  });
  test("rejects a non-decimal amount and a bad currency", () => {
    expect(accepts(json, { amount: "abc", currency: "CZK" })).toBe(false);
    expect(accepts(json, { amount: "1", currency: "czk" })).toBe(false);
  });
});

describe("Contact overrides", () => {
  test("every field is optional and the series map is partial", () => {
    expect(accepts(ContactDefaults, {})).toBe(true);
    expect(
      accepts(ContactDefaults, {
        currency: "EUR",
        dueDays: 14,
        preferredSeriesByKind: { invoice: "0192f0c4-1b2c-7d3e-8f40-0123456789ab" },
        reminderPolicy: { mode: "custom", offsetsDays: [3, 10] },
      }),
    ).toBe(true);
  });
  test("rejects an unknown reminder mode and a fractional due", () => {
    expect(accepts(ReminderPolicy, { mode: "weekly" })).toBe(false);
    expect(accepts(ContactDefaults, { dueDays: 1.5 })).toBe(false);
  });
  test("resolves Document, then Contact, then Workspace", () => {
    expect(resolveDefault("doc", "contact", "ws")).toBe("doc");
    expect(resolveDefault(undefined, "contact", "ws")).toBe("contact");
    expect(resolveDefault(undefined, undefined, "ws")).toBe("ws");
    // falsy values set on a level still win
    expect(resolveDefault(0, 14, 30)).toBe(0);
    expect(resolveDefault(14, 30)(0)).toBe(0);
  });
});

describe("Theme", () => {
  test("graphite_atelier leads the preset list", () => {
    expect(ThemePresetId.literals[0]).toBe("graphite_atelier");
  });
  test("sources: preset, seed hex, raw Material Theme Builder JSON", () => {
    expect(accepts(ThemeSource, { _tag: "Preset", id: "forest" })).toBe(true);
    expect(accepts(ThemeSource, { _tag: "Seed", seed: "#1D4ED8" })).toBe(true);
    expect(accepts(ThemeSource, { _tag: "Seed", seed: "1D4ED8" })).toBe(false);
    expect(accepts(ThemeSource, { _tag: "MaterialThemeBuilder", json: { seed: "#000000" } })).toBe(
      true,
    );
    expect(accepts(ThemeSource, { _tag: "Preset", id: "neon" })).toBe(false);
  });
  test("account preference carries style elegant or cozy", () => {
    const base = { mode: "system", contrast: "standard", dynamicColor: true, source: null };
    expect(accepts(ThemePreference, { ...base, style: "elegant" })).toBe(true);
    expect(accepts(ThemePreference, { ...base, style: "cozy" })).toBe(true);
    expect(accepts(ThemePreference, { ...base, style: "playful" })).toBe(false);
  });
});
