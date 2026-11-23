import { describe, expect, test } from "bun:test";
import type { Locale, PdfTemplate } from "@kvitbit/domain";
import { type DocumentRenderModel, renderDocumentHtml, renderReportHtml } from "../../src/pdf";
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

const TEMPLATES: ReadonlyArray<PdfTemplate> = ["classic", "modern_minimal"];
const LANGS: ReadonlyArray<Locale> = ["cs", "en"];

/** Visible text: tags dropped, entities decoded, non-breaking spaces as spaces. */
const text = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ");

const section = (html: string, name: string): string | null => {
  const m = new RegExp(`data-section="${name}"[^>]*>([\\s\\S]*?)</(div|table|span)>`).exec(html);
  return m?.[1] === undefined ? null : text(m[1]).trim();
};

const both = (model: DocumentRenderModel, lang: Locale = "cs") =>
  TEMPLATES.map((tpl) => [tpl, renderDocumentHtml(model, tpl, lang)] as const);

describe("every template, document kind and language renders a self-contained A4 page", () => {
  for (const tpl of TEMPLATES)
    for (const variant of VARIANTS)
      for (const lang of LANGS)
        test(`${tpl} ${variant} ${lang}`, () => {
          const html = renderDocumentHtml(czkModel(variant), tpl, lang);
          expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
          expect(html).toContain(`<html lang="${lang}">`);
          expect(html).toContain("@page { size: A4;");
          expect(html).toContain(`data-template="${tpl}"`);
          expect(html).not.toMatch(/<script|<link|(?:src|href)=["']https?:|url\(/);
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
      expect(html).not.toMatch(/<th class="r">DPH<\/th>/);
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
      expect(html).toMatch(/<div class="watermark" data-watermark="draft"><span>Návrh<\/span>/);
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
        expect(html).toMatch(
          /data-section="qr"[\s\S]*?<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/,
        );
        expect(text(html)).toContain("QR Platba");
      }
    for (const variant of ["ptd", "credit"] as const)
      for (const [, html] of both(czkModel(variant)))
        expect(html).not.toContain('data-section="qr"');
  });

  test("EPC caption for EUR", () => {
    const [[, classic], [, modern]] = both(eurModel(), "en") as [
      readonly [PdfTemplate, string],
      readonly [PdfTemplate, string],
    ];
    expect(text(classic)).toContain("EPC QR (SEPA)");
    expect(text(modern)).toContain("EPC QR · SEPA transfer");
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
      if (tpl === "classic") expect(text(html)).not.toContain("Datum splatnosti");
      else expect(text(html)).toContain("Uhrazeno");
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
    lines: czkModel().lines.map((l) => ({ ...l, description: `${l.description} </td><b>` })),
    note: "Line 1\n<i>Line 2</i>",
    branding: {
      accentColor: "red; } body { display:none",
      footerText: `Footer "quoted" <b>`,
      logo: { mediaType: "text/html" as "image/png", bytes: new TextEncoder().encode("<script>") },
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
      expect(html).toMatch(/--p-tint: #[0-9A-F]{6};/);
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
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('data-template="report"');
    expect(html).not.toMatch(/<script|<link|(?:src|href)=["']https?:|url\(/);
    expect(t).toContain("Export přehledu · Q4 2026");
    expect(t).toContain("Souhrn DPH a cashflow");
    expect(t).toContain("Tržby bez DPH 412 800,00 Kč");
    expect(html).toContain('class="rk-v accent"');
    expect(t).toContain("Tuzemská plnění — základní sazba 21 % 11 346 000,00 Kč 72 660,00 Kč");
    expect(html).toContain('<tr class="deduct">');
    expect(t).toContain("−20 248,00 Kč");
    expect(section(html, "grand-total")).toBe("57 892,00 Kč");
    expect(t).toMatch(/Podklad pro účetní a daňové přiznání · Vygenerováno 23\. 11\. 2026 14:20/);
    expect(html).toContain("--p-accent: #0F5D42;");
  });

  test("en formatting and escaping", () => {
    const model = { ...reportModel(), title: "<b>VAT</b> & Cashflow" };
    const html = renderReportHtml(model, "en");
    expect(html).toContain("&lt;b&gt;VAT&lt;/b&gt; &amp; Cashflow");
    expect(text(html)).toContain("412,800.00 CZK");
    expect(text(html)).toMatch(/Generated 23 Nov 2026 14:20/);
  });
});
