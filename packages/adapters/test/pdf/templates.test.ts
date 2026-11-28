import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { brandAssets } from "@kvitbit/brand";
import type { Locale, PdfTemplate } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { type DocumentRenderModel, renderDocumentHtml, renderReportHtml } from "../../src/pdf";
import { HORIZONTAL_LOCKUP_LIGHT_SVG } from "../../src/pdf/lockup";
import { SHEET_ZOOM } from "../../src/pdf/shell";
import {
  bd,
  czkModel,
  eurModel,
  eurRatedModel,
  identifiedPersonModel,
  nonVatModel,
  reportModel,
  VARIANTS,
} from "./fixtures";

const VAT_COLUMN = /<th class="r">DPH<\/th>/;
const DRAFT_WATERMARK = /<div class="watermark" data-watermark="draft"><span>Návrh<\/span>/;
const PAYMENT_QR = /data-section="qr"[\s\S]*?<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/;
const TINT_COLOR = /--p-tint: #[0-9A-F]{6};/;
const EXTERNAL_MARKUP = /<script|<link|(?:src|href)=["']https?:|url\(/;
const GENERATED_CS = /Podklad pro účetní a daňové přiznání · Vygenerováno 23\. 11\. 2026 14:20/;
const GENERATED_EN = /Generated 23 Nov 2026 14:20/;
const BRAND_LOCKUP = /data-section="brand"><svg [^>]*viewBox="0.00 0.00 366.01 75.04"/;

const TEMPLATES = ["classic", "modern_minimal"] as const satisfies ReadonlyArray<PdfTemplate>;
const LANGS: ReadonlyArray<Locale> = ["cs", "en"];

/** Visible text: tags dropped, entities decoded, non-breaking spaces as spaces. */
const text = (html: string): string =>
  Str.replace(
    /\s+/g,
    " ",
  )(
    Str.replace(
      / /g,
      " ",
    )(
      Str.replace(
        /&amp;/g,
        "&",
      )(
        Str.replace(
          /&#39;/g,
          "'",
        )(
          Str.replace(
            /&quot;/g,
            '"',
          )(
            Str.replace(
              /&gt;/g,
              ">",
            )(
              Str.replace(
                /&lt;/g,
                "<",
              )(Str.replace(/<[^>]+>/g, " ")(Str.replace(/<style>[\s\S]*?<\/style>/g, " ")(html))),
            ),
          ),
        ),
      ),
    ),
  );

const section = (html: string, name: string): string | null => {
  const m = new RegExp(`data-section="${name}"[^>]*>([\\s\\S]*?)</(div|table|span)>`).exec(html);
  return m?.[1] === undefined ? null : Str.trim(text(m[1]));
};

const both = (model: DocumentRenderModel, lang: Locale = "cs") =>
  Arr.map(TEMPLATES, (tpl) => [tpl, renderDocumentHtml(model, tpl, lang)] as const);

describe("every template, document kind and language renders a self-contained A4 page", () => {
  for (const tpl of TEMPLATES)
    for (const variant of VARIANTS)
      for (const lang of LANGS)
        test(`${tpl} ${variant} ${lang}`, () => {
          const html = renderDocumentHtml(czkModel(variant), tpl, lang);
          expect(Str.startsWith("<!DOCTYPE html>")(html)).toBe(true);
          expect(html).toContain(`<html lang="${lang}">`);
          expect(html).toContain("@page { size: A4;");
          expect(html).toContain(`data-template="${tpl}"`);
          expect(html).not.toMatch(EXTERNAL_MARKUP);
          expect(html).not.toContain("undefined");
          expect(html).not.toContain("NaN");
          expect(text(html)).toContain(czkModel(variant).number ?? "");
        });
});

describe("titles per kind and Tax Regime", () => {
  const cases = [
    ["invoice", "Faktura – daňový doklad", "Faktura", "Invoice – tax document"],
    ["proforma", "Zálohová faktura", "Zálohová faktura", "Proforma invoice"],
    ["ptd", "Daňový doklad k přijaté platbě", "Potvrzení o přijaté platbě", "Payment tax document"],
    ["credit", "Opravný daňový doklad", "Dobropis", "Credit note – corrective tax document"],
    ["final", "Faktura – vyúčtování záloh", "Vyúčtovací faktura", "Final settlement invoice"],
  ] as const;
  for (const [variant, vatCs, nonVatCs, vatEn] of cases)
    test(variant, () => {
      for (const [, html] of both(czkModel(variant))) expect(section(html, "title")).toBe(vatCs);
      for (const [, html] of both(nonVatModel(variant)))
        expect(section(html, "title")).toBe(nonVatCs);
      for (const [, html] of both(czkModel(variant), "en"))
        expect(section(html, "title")).toBe(vatEn);
    });
});

describe("statutory text per Tax Regime", () => {
  test("VAT payer, domestic: no regime note; §435 register entry printed", () => {
    for (const [, html] of both(czkModel())) {
      expect(section(html, "statutory")).toBeNull();
      expect(html).toContain('data-note="register_entry"');
      expect(text(html)).toContain(
        "Zapsána v OR u Městského soudu v Praze, oddíl C, vložka 334912.",
      );
    }
  });

  test("non-VAT payer: not-a-VAT-payer note, no VAT column, recap or DIČ", () => {
    for (const [tpl, html] of both(nonVatModel())) {
      expect(section(html, "statutory")).toBe("Dodavatel není plátcem DPH.");
      expect(html).not.toContain('data-section="vat-recap"');
      expect(html).not.toMatch(VAT_COLUMN);
      expect(text(html)).not.toContain("CZ09482711");
      expect(text(html), tpl).toContain("48 500,00 Kč");
    }
    for (const [, html] of both(nonVatModel(), "en"))
      expect(section(html, "statutory")).toBe("The supplier is not a VAT payer.");
  });

  test("identified person, domestic supply", () => {
    for (const [, html] of both(identifiedPersonModel()))
      expect(section(html, "statutory")).toBe(
        "Dodavatel je identifikovanou osobou k DPH; není plátcem DPH.",
      );
  });

  test("reverse charge (exact §29(2)(c) wording) and proforma not-a-tax-document", () => {
    for (const [, html] of both(eurModel()))
      expect(section(html, "statutory")).toBe("Daň odvede zákazník.");
    for (const [, html] of both(eurModel(), "en"))
      expect(section(html, "statutory")).toBe("Reverse charge.");
    for (const [, html] of both(czkModel("proforma"))) {
      expect(section(html, "statutory")).toBe("Nejedná se o daňový doklad.");
      expect(html).not.toContain('data-section="vat-recap"');
    }
  });

  test("core-supplied notes replace derived ones; the issuer's register entry still prints", () => {
    const model = {
      ...czkModel(),
      statutoryNotes: [{ code: "custom", text: "Vystaveno zákazníkem." }],
    };
    for (const [, html] of both(model)) {
      expect(section(html, "statutory")).toBe("Vystaveno zákazníkem.");
      expect(html).toContain('data-note="register_entry"');
    }
  });
});

describe("Draft watermark", () => {
  test("present only for drafts, with the draft label instead of a number", () => {
    const draft = { ...czkModel(), status: "draft" as const, number: null };
    for (const [, html] of both(draft)) {
      expect(html).toContain('data-watermark="draft"');
      expect(html).toMatch(DRAFT_WATERMARK);
    }
    for (const [, html] of both(draft, "en")) expect(html).toContain("<span>Draft</span>");
    for (const status of ["issued", "cancelled"] as const)
      for (const [, html] of both({ ...czkModel(), status }))
        expect(html).not.toContain("data-watermark");
  });
});

describe("CNB FX disclosure", () => {
  test("non-CZK: rate, fixing date, CZK VAT per bucket and CZK equivalent", () => {
    for (const [, html] of both(eurRatedModel())) {
      expect(section(html, "fx")).toBe(
        "Přepočet pro účely DPH dle kurzu ČNB ze dne 02. 11. 2026: 1 EUR = 25,240 Kč. DPH v Kč: 21 %: 9 010,68 Kč; 12 %: 787,49 Kč; Celkem 9 798,17 Kč.",
      );
      expect(section(html, "czk-equivalent")).toBe("≈ 59 268,57 Kč (ČNB)");
      expect(text(html)).toContain("2 348,20 €");
    }
    for (const [, html] of both(eurRatedModel(), "en"))
      expect(section(html, "fx")).toBe(
        "Converted for Czech VAT at the CNB fixing of 02 Nov 2026: 1 EUR = 25.240 CZK. VAT in CZK: 21%: 9,010.68 CZK; 12%: 787.49 CZK; Total 9,798.17 CZK.",
      );
  });

  test("reverse charge EUR prints the zero-VAT bucket", () => {
    for (const [, html] of both(eurModel())) {
      expect(section(html, "fx")).toContain(
        "DPH v Kč: 0 % (přenesení daňové povinnosti): 0,00 Kč.",
      );
      expect(section(html, "czk-equivalent")).toBe("≈ 49 470,40 Kč (ČNB)");
    }
  });

  test("manual rate names the supplier rate and no fixing date", () => {
    const model = {
      ...eurModel(),
      fx: { rate: bd("2524"), quantity: 100, fixingDate: null, source: "manual" as const },
    };
    for (const [, html] of both(model)) {
      expect(section(html, "fx")).toContain(
        "Přepočet pro účely DPH kurzem stanoveným dodavatelem: 100 EUR = 2 524,000 Kč.",
      );
      expect(section(html, "czk-equivalent")).toBe("≈ 49 470,40 Kč (kurz dodavatele)");
    }
  });

  test("absent for CZK documents", () => {
    for (const variant of VARIANTS)
      for (const [, html] of both(czkModel(variant))) {
        expect(html).not.toContain('data-section="fx"');
        expect(html).not.toContain('data-section="czk-equivalent"');
      }
  });
});

describe("payment QR", () => {
  test("SPAYD QR on invoice, proforma and final invoice; none on PTD and Credit Note", () => {
    for (const variant of ["invoice", "proforma", "final"] as const)
      for (const [, html] of both(czkModel(variant))) {
        expect(html).toMatch(PAYMENT_QR);
        expect(text(html)).toContain("QR Platba");
      }
    for (const variant of ["ptd", "credit"] as const)
      for (const [, html] of both(czkModel(variant)))
        expect(html).not.toContain('data-section="qr"');
  });

  test("EPC caption for EUR", () => {
    const model = eurModel();
    const classic = renderDocumentHtml(model, "classic", "en");
    const modern = renderDocumentHtml(model, "modern_minimal", "en");
    expect(text(classic)).toContain("EPC QR (SEPA)");
    expect(text(modern)).toContain("EPC QR (SEPA) · Bank transfer");
  });
});

describe("amounts, references and totals", () => {
  test("cs and en money formats", () => {
    for (const [, html] of both(czkModel())) {
      expect(section(html, "grand-total")).toBe("58 100,00 Kč");
      expect(text(html)).toContain("Celkem k úhradě");
    }
    for (const [, html] of both(czkModel(), "en")) {
      expect(section(html, "grand-total")).toBe("58,100.00 CZK");
      expect(text(html)).toContain("Total due");
    }
  });

  test("VAT recap per rate with a sum row (Classic)", () => {
    const html = renderDocumentHtml(czkModel(), "classic", "cs");
    expect(section(html, "vat-recap")).toBe(
      "Sazba DPH Základ DPH Celkem 21 % 42 000,00 Kč 8 820,00 Kč 50 820,00 Kč 12 % 6 500,00 Kč 780,00 Kč 7 280,00 Kč Celkem 48 500,00 Kč 9 600,00 Kč 58 100,00 Kč",
    );
  });

  test("Credit Note: negative amounts, correction reference and credit label", () => {
    for (const [, html] of both(czkModel("credit"))) {
      expect(section(html, "grand-total")).toBe("−7 280,00 Kč");
      expect(section(html, "reference")).toBe(
        "Oprava k původnímu dokladu č. 2026-0031 ze dne 14. 10. 2026. Důvod opravy: Snížení rozsahu tiskové přípravy dle dohody.",
      );
      expect(html).toContain('class="r neg"');
    }
  });

  test("Payment Tax Document: received payment reference, paid label, no due date", () => {
    for (const [tpl, html] of both(czkModel("ptd"))) {
      expect(section(html, "reference")).toBe(
        "Vystaveno k přijaté platbě ze dne 02. 11. 2026 podle zálohové faktury č. Z2026-014.",
      );
      expect(text(html)).toContain("Uhrazená záloha");
      const expected = tpl === "modern_minimal";
      const heading = tpl === "classic" ? "Datum splatnosti" : "Uhrazeno";
      expect(Str.includes(heading)(text(html))).toBe(expected);
    }
  });

  test("Final Invoice: deduction row, supplies total, deposit and remaining balance", () => {
    for (const [, html] of both(czkModel("final"))) {
      expect(html).toContain('<tr class="deduct">');
      const t = text(html);
      expect(t).toContain("Celkem za plnění 58 100,00 Kč");
      expect(t).toContain("Odpočet zálohy −20 000,00 Kč");
      expect(t).toContain("Zbývá k úhradě");
      expect(section(html, "grand-total")).toBe("38 100,00 Kč");
      expect(section(html, "reference")).toBe(
        "Vyúčtování zakázky s odpočtem uhrazené zálohy č. Z2026-014 (daňový doklad k platbě č. DDP-2026-007).",
      );
    }
  });
});

describe("escaping and branding safety", () => {
  const hostile: DocumentRenderModel = {
    ...czkModel(),
    customer: {
      ...czkModel().customer,
      name: `<script>alert("x")</script> & Co`,
      addressLines: ["<img src=x onerror=alert(1)>"],
    },
    lines: Arr.map(czkModel().lines, (l) => ({ ...l, description: `${l.description} </td><b>` })),
    note: "Line 1\n<i>Line 2</i>",
    branding: {
      accentColor: "red; } body { display:none",
      footerText: `Footer "quoted" <b>`,
      logo: {
        // @ts-expect-error Exercise the runtime media type guard with an unsupported input.
        mediaType: "text/html",
        bytes: new TextEncoder().encode("<script>"),
      },
      stamp: null,
    },
  };

  test("user text is escaped in every template", () => {
    for (const [, html] of both(hostile)) {
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("</td><b>");
      expect(html).not.toContain("<i>Line 2</i>");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
      expect(html).toContain("Footer &quot;quoted&quot; &lt;b&gt;");
    }
  });

  test("invalid accent falls back to Graphite; unsupported logo types are dropped", () => {
    for (const [, html] of both(hostile)) {
      expect(html).toContain("--p-accent: #18181B;");
      expect(html).not.toContain("display:none");
      expect(html).not.toContain("data:text/html");
    }
  });

  test("valid accent, tint, logo and stamp are embedded as data URIs", () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const model = {
      ...czkModel(),
      branding: {
        accentColor: "#0f5d42",
        footerText: "Děkujeme",
        logo: { mediaType: "image/png" as const, bytes: png },
        stamp: { mediaType: "image/png" as const, bytes: png },
      },
    };
    for (const [, html] of both(model)) {
      expect(html).toContain("--p-accent: #0F5D42;");
      expect(html).toMatch(TINT_COLOR);
      expect(html).toContain(
        '<img class="logo-img" alt="Ateliér Kalný s.r.o." src="data:image/png;base64,iVBORw==">',
      );
      expect(html).toContain('<img class="stamp-img"');
      expect(html).not.toContain('<span class="logo-box">');
      expect(html).not.toContain('<span class="logo-pill">');
    }
  });

  test("without a logo, the issuer's initials stand in", () => {
    expect(renderDocumentHtml(czkModel(), "classic", "cs")).toContain(
      '<span class="logo-box">AK</span>',
    );
    expect(renderDocumentHtml(czkModel(), "modern_minimal", "cs")).toContain(
      '<span class="logo-pill">AK</span>',
    );
  });
});

describe("report export (D11)", () => {
  test("KPIs, table rows, deduction tone, net total and footer", () => {
    const html = renderReportHtml(reportModel(), "cs");
    const t = text(html);
    expect(Str.startsWith("<!DOCTYPE html>")(html)).toBe(true);
    expect(html).toContain('data-template="report"');
    expect(html).not.toMatch(EXTERNAL_MARKUP);
    expect(t).toContain("Export přehledu · Q4 2026");
    expect(t).toContain("Souhrn DPH a cashflow");
    expect(t).toContain("Tržby bez DPH 412 800,00 Kč");
    expect(html).toContain('class="rk-v accent"');
    expect(t).toContain("Tuzemská plnění — základní sazba 21 % 11 346 000,00 Kč 72 660,00 Kč");
    expect(html).toContain('<tr class="deduct">');
    expect(t).toContain("−20 248,00 Kč");
    expect(section(html, "grand-total")).toBe("57 892,00 Kč");
    expect(t).toMatch(GENERATED_CS);
    expect(html).toContain("--p-accent: #0F5D42;");
  });

  test("en formatting and escaping", () => {
    const model = { ...reportModel(), title: "<b>VAT</b> & Cashflow" };
    const html = renderReportHtml(model, "en");
    expect(html).toContain("&lt;b&gt;VAT&lt;/b&gt; &amp; Cashflow");
    expect(text(html)).toContain("412,800.00 CZK");
    expect(text(html)).toMatch(GENERATED_EN);
  });
});

describe("council regressions", () => {
  test("Final Invoice subtotal excludes payment rounding, which prints once", () => {
    for (const adj of ["0.4", "-0.4"]) {
      const m = czkModel("final");
      const gross = BigDecimal.sum(m.totals.gross.amount, bd(adj));
      const model = {
        ...m,
        totals: {
          ...m.totals,
          roundingAdjustment: { ...m.totals.roundingAdjustment, amount: bd(adj) },
          gross: { ...m.totals.gross, amount: gross },
        },
      };
      for (const [, html] of both(model)) {
        const t = text(html);
        expect(t).toContain("Celkem za plnění 58 100,00 Kč");
        Str.match(/Zaokrouhlení/g)(t)
          .pipe(Option.getOrNull, expect)
          .toHaveLength(1);
        expect(t).toContain(adj === "0.4" ? "Zaokrouhlení 0,40 Kč" : "Zaokrouhlení −0,40 Kč");
      }
    }
  });

  test("Modern Minimal prints a per-rate VAT recap on Final Invoices and multi-rate tax documents", () => {
    const expected = {
      final: "21 % 25 471,07 Kč 5 348,93 Kč 30 820,00 Kč 12 % 6 500,00 Kč 780,00 Kč 7 280,00 Kč",
      invoice: "21 % 42 000,00 Kč 8 820,00 Kč 50 820,00 Kč 12 % 6 500,00 Kč 780,00 Kč 7 280,00 Kč",
    } as const;
    for (const variant of ["final", "invoice"] as const) {
      const html = renderDocumentHtml(czkModel(variant), "modern_minimal", "cs");
      expect(section(html, "vat-recap")).toContain(expected[variant]);
    }
    const ptd = renderDocumentHtml(czkModel("ptd"), "modern_minimal", "cs");
    expect(ptd).not.toContain('data-section="vat-recap"');
  });

  test("foreign-currency non-tax documents get the plain rate without VAT wording", () => {
    const eurNonVat = { ...nonVatModel(), currency: eurModel().currency, fx: eurModel().fx };
    const eurProforma = { ...eurRatedModel(), kind: "proforma" as const, taxDocument: false };
    for (const model of [eurNonVat, eurProforma])
      for (const [, html] of both(model)) {
        expect(section(html, "fx")).toBe(
          "Přepočet dle kurzu ČNB ze dne 02. 11. 2026: 1 EUR = 25,240 Kč.",
        );
        expect(html).toContain('data-section="czk-equivalent"');
      }
    for (const [, html] of both(eurNonVat, "en"))
      expect(section(html, "fx")).toBe(
        "Converted at the CNB fixing of 02 Nov 2026: 1 EUR = 25.240 CZK.",
      );
  });
});

describe("review regressions", () => {
  test("a manual rate prints with every decimal it carries", () => {
    const model = {
      ...eurModel(),
      fx: { rate: bd("0.0004"), quantity: 1, fixingDate: null, source: "manual" as const },
    };
    for (const [, html] of both(model)) expect(section(html, "fx")).toContain("1 EUR = 0,0004 Kč");
    const source = eurModel();
    if (source.fx === null) throw new Error("EUR fixture requires FX metadata");
    const cnb = { ...source, fx: { ...source.fx, rate: bd("25.2") } };
    for (const [, html] of both(cnb)) expect(section(html, "fx")).toContain("1 EUR = 25,200 Kč");
  });

  test("Modern Minimal always prints the payment method", () => {
    const cash = {
      ...czkModel(),
      paymentMethod: "cash" as const,
      bankAccount: null,
      paymentQr: null,
    };
    expect(section(renderDocumentHtml(cash, "modern_minimal", "cs"), "payment-method")).toBe(
      "Hotově",
    );
    expect(section(renderDocumentHtml(czkModel(), "modern_minimal", "cs"), "payment-method")).toBe(
      "QR Platba · Bankovní převod",
    );
    expect(
      section(renderDocumentHtml(czkModel("credit"), "modern_minimal", "en"), "payment-method"),
    ).toBe("Bank transfer");
  });

  test("footers carry the committed horizontal lockup at the 5 mm print minimum with clear space", async () => {
    const committed = await Bun.file(
      fileURLToPath(new URL(`../../../../${brandAssets.lockup.horizontalLight}`, import.meta.url)),
    ).text();
    expect(HORIZONTAL_LOCKUP_LIGHT_SVG).toBe(committed);
    const zoomed = (mm: number) => `${(mm / SHEET_ZOOM).toFixed(3)}mm`;
    const pages = [
      ...Arr.map(both(czkModel()), ([, h]) => h),
      renderReportHtml(reportModel(), "cs"),
    ];
    for (const html of pages) {
      expect(html).toMatch(BRAND_LOCKUP);
      expect(html).toContain(`.brand-lockup svg { display: block; height: ${zoomed(5)};`);
      expect(html).toContain(`.brand-lockup { display: inline-block; padding: ${zoomed(2.5)};`);
    }
  });
});
