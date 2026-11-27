import { describe, expect, test } from "bun:test";
import {
  type EmailTemplate,
  escapeHtml,
  formatDate,
  formatDuration,
  formatFileSize,
  formatMoney,
  NBSP,
  renderEmail,
} from "@kvitbit/adapters/templates/email";
import { CurrencyCode, IsoDate, type Locale, MoneyMath } from "@kvitbit/domain/contract";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

const money = (amount: string, currency = "CZK") =>
  MoneyMath.make(BigDecimal.fromStringUnsafe(amount), CurrencyCode.make(currency));
/** Writes expected strings with "_" where a U+00A0 must be. */
const nb = Str.replaceAll("_", NBSP);

const workspace = {
  name: "Ateliér Kalný s.r.o.",
  accent: { color: "#0F5D42", onColor: "#FFFFFF" },
};
const footer = {
  address: "Křižíkova 185/35, Praha 8",
  companyId: "09482711",
  replyTo: "fakturace@atelierkalny.cz",
};

const fixtures = {
  "E01 verify": {
    id: "E01",
    variant: "verify",
    url: "https://kvitbit.app/verify?t=abc",
    validForMinutes: 1440,
  },
  "E01 already_registered": {
    id: "E01",
    variant: "already_registered",
    url: "https://kvitbit.app/login",
  },
  E02: {
    id: "E02",
    email: "filip@atelierkalny.cz",
    url: "https://kvitbit.app/magic?t=abc",
    validForMinutes: 15,
    requestedFrom: "Praha, CZ (Chrome · Linux)",
  },
  E03: {
    id: "E03",
    email: "filip@atelierkalny.cz",
    url: "https://kvitbit.app/reset?t=abc",
    validForMinutes: 60,
    magicLinkUrl: "https://kvitbit.app/magic?t=def",
  },
  E04: {
    id: "E04",
    workspace,
    inviterName: "Filip Kalný",
    inviteeEmail: "tomas@atelierkalny.cz",
    role: "member",
    url: "https://kvitbit.app/invite/xyz",
    validForDays: 7,
    expiresOn: IsoDate.make("2026-11-30"),
  },
  E05: {
    id: "E05",
    workspace,
    documentKind: "invoice",
    documentNumber: "2026-0042",
    amount: money("58100"),
    dueDate: IsoDate.make("2026-11-16"),
    variableSymbol: "20260042",
    bankAccount: "2101482910/2010",
    shareUrl: "https://kvitbit.app/i/tok",
    paymentQr: "spayd",
    attachment: { filename: "faktura-2026-0042.pdf", sizeBytes: 65_000 },
    footer,
  },
  E06: {
    id: "E06",
    workspace,
    documentKind: "invoice",
    documentNumber: "2026-0042",
    amountDue: money("58100"),
    dueDate: IsoDate.make("2026-11-16"),
    daysOverdue: 10,
    variableSymbol: "20260042",
    shareUrl: "https://kvitbit.app/i/tok",
    paymentQr: "spayd",
    footer,
  },
  "E07 confirm_new": {
    id: "E07",
    variant: "confirm_new",
    oldEmail: "filip@atelierkalny.cz",
    newEmail: "filip.novy@atelierkalny.cz",
    url: "https://kvitbit.app/email/confirm?t=abc",
    validForMinutes: 60,
  },
  "E07 notice_old": {
    id: "E07",
    variant: "notice_old",
    newEmail: "filip.novy@atelierkalny.cz",
    url: "https://kvitbit.app/settings/security",
  },
  E08: {
    id: "E08",
    workspaceName: "Ateliér Kalný s.r.o.",
    scheduleName: "Měsíční paušál — Nordic Craft GmbH",
    occurrenceDate: IsoDate.make("2026-11-01"),
    reason: "Kontakt nemá e-mail pro automatické odeslání.",
    url: "https://kvitbit.app/w/ak/schedules/1",
  },
} satisfies Record<string, EmailTemplate>;

/** Per fixture and locale: subject, then fragments the text part must contain. */
const expected = {
  "E01 verify": {
    cs: [
      "Potvrďte svou e-mailovou adresu — Kvitbit",
      ["Potvrďte svůj e-mail", nb("Odkaz platí 1_den."), "https://kvitbit.app/verify?t=abc"],
    ],
    en: [
      "Verify your email address — Kvitbit",
      ["Confirm your email", nb("expires in 1_day."), "Verify email address:"],
    ],
  },
  "E01 already_registered": {
    cs: [
      "Pokus o registraci v Kvitbitu",
      ["Účet s tímto e-mailem už existuje", "https://kvitbit.app/login"],
    ],
    en: ["Sign-up attempt on Kvitbit", ["An account already exists", "Sign in to your account:"]],
  },
  E02: {
    cs: [
      "Jednorázový odkaz pro přihlášení do Kvitbitu",
      [
        nb("platí 15_minut."),
        "Místo požadavku: Praha, CZ (Chrome · Linux).",
        "filip@atelierkalny.cz",
      ],
    ],
    en: [
      "Your one-time sign-in link for Kvitbit",
      [nb("valid for 15_minutes."), "Sign in to Kvitbit:"],
    ],
  },
  E03: {
    cs: [
      "Obnovení hesla k účtu Kvitbit",
      [nb("Odkaz platí 1_hodinu."), "Nastavit nové heslo:", "https://kvitbit.app/magic?t=def"],
    ],
    en: [
      "Reset your Kvitbit password",
      [nb("Expires in 1_hour."), "Or sign in with a one-time link:"],
    ],
  },
  E04: {
    cs: [
      "Filip Kalný vás zve do prostoru Ateliér Kalný s.r.o.",
      [
        "Filip Kalný vás zve do prostoru Ateliér Kalný s.r.o. s rolí Člen (vystavování dokladů, náklady, kontakty)",
        nb("platí 7_dní (do 30._11._2026)"),
      ],
    ],
    en: [
      "Filip Kalný invited you to Ateliér Kalný s.r.o.",
      ["as a Member (issue documents", nb("expires in 7_days (30_Nov_2026)")],
    ],
  },
  E05: {
    cs: [
      nb("Faktura 2026-0042 — Ateliér Kalný s.r.o. (58_100,00_Kč)"),
      [
        "Zasíláme fakturu č. 2026-0042",
        nb("Částka k úhradě: 58_100,00_Kč"),
        nb("Datum splatnosti: 16._11._2026"),
        "Variabilní symbol: 20260042",
        "Bankovní účet: 2101482910/2010",
        nb("PDF: faktura-2026-0042.pdf (64_KB)"),
        "Zobrazit fakturu a QR kód:\nhttps://kvitbit.app/i/tok",
        "IČO 09482711 · Reply-To: fakturace@atelierkalny.cz",
      ],
    ],
    en: [
      nb("Invoice 2026-0042 — Ateliér Kalný s.r.o. (CZK_58,100.00)"),
      [
        nb("Total due: CZK_58,100.00"),
        nb("Due date: 16_Nov_2026"),
        "View invoice & QR code:",
        "ID 09482711",
      ],
    ],
  },
  E06: {
    cs: [
      nb("Připomínka splatnosti faktury 2026-0042 (10_dní po splatnosti)"),
      [
        nb("[10_dní po splatnosti]"),
        nb("se splatností 16._11._2026"),
        nb("Zbývá uhradit: 58_100,00_Kč"),
      ],
    ],
    en: [
      nb("Reminder: Invoice 2026-0042 is 10_days overdue"),
      [nb("[10_days overdue]"), nb("(due 16_Nov_2026)"), nb("Amount overdue: CZK_58,100.00")],
    ],
  },
  "E07 confirm_new": {
    cs: [
      "Potvrďte novou e-mailovou adresu — Kvitbit",
      ["z filip@atelierkalny.cz na filip.novy@atelierkalny.cz", nb("Odkaz platí 1_hodinu.")],
    ],
    en: [
      "Confirm your new email address — Kvitbit",
      ["Confirm new email:", nb("expires in 1_hour.")],
    ],
  },
  "E07 notice_old": {
    cs: [
      "Bezpečnostní upozornění: požadavek na změnu e-mailu",
      // biome-ignore lint/security/noSecrets: Czech UI copy used as an expected fragment.
      ["[Bezpečnostní upozornění]", "filip.novy@atelierkalny.cz"],
    ],
    en: [
      "Security alert: email change requested",
      ["[Security alert]", "Review account security:"],
    ],
  },
  E08: {
    cs: [
      "Vyžaduje pozornost: pravidelné vystavení dokladu selhalo (Ateliér Kalný s.r.o.)",
      ["[Vyžaduje pozornost]", nb("k datu 1._11._2026"), "Důvod chyby:\nKontakt nemá e-mail"],
    ],
    en: [
      "Action needed: recurring document run failed (Ateliér Kalný s.r.o.)",
      ["[Needs attention]", nb("for 1_Nov_2026"), "Reason:"],
    ],
  },
} satisfies Record<keyof typeof fixtures, Record<Locale, readonly [string, ReadonlyArray<string>]>>;

const LEFTOVERS = ["{{", "undefined", "null", "NaN", "[object Object]"];
const HTML_TAGS = /<[^>]+>/g;
const FRAGMENT_SEPARATOR = /\n|: /;
const FRAGMENT_DELIMITERS = /^\[|\]$|:$/g;
const HTML_TAG = /<\/?[a-z][^>]*>/i;
const UNSAFE_HTML = /<script|<link|@import|javascript:/i;
const CUSTOM_MESSAGE_HTML = /Line one [^<]*<br>Line two<\/p><p[^>]*>Second paragraph/;
const HEADER_LINE_BREAK = /[\r\n]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WRAPPED_EMAIL = /word-break:break-all;">a{60}@example\.com/;
const INVOICE_WORDING = /faktur|invoice/i;

describe("renderEmail: every template in cs and en", () => {
  for (const [name, template] of Rec.toEntries(fixtures)) {
    for (const locale of ["cs", "en"] as const) {
      test(`${name} ${locale}`, () => {
        const out = renderEmail(template, locale);
        const [subject, fragments] = expected[name][locale];
        expect(out.subject).toBe(subject);
        for (const f of fragments) expect(out.text).toContain(f);

        expect(Str.startsWith("<!DOCTYPE html>")(out.html)).toBe(true);
        expect(out.html).toContain(`<html lang="${locale}"`);
        expect(out.html).toContain(
          '<table role="presentation" class="kb-container kb-card" width="600"',
        );
        expect(out.html).toContain("max-width:600px");
        expect(out.html).toContain(`<title>${escapeHtml(subject)}</title>`);
        // The same content reaches the HTML part: labels and values (split at the text part's
        // "Label: value" and line breaks) in its visible text, URLs in an href.
        const htmlText = Fn.pipe(
          out.html,
          Str.replace(HTML_TAGS, ""),
          Str.replaceAll("&nbsp;", NBSP),
          Str.replaceAll("&amp;", "&"),
          Str.replaceAll("&#39;", "'"),
          Str.replaceAll("&quot;", '"'),
        );
        for (const f of fragments)
          for (const fragment of Str.split(f, FRAGMENT_SEPARATOR)) {
            const piece = Fn.pipe(fragment, Str.replace(FRAGMENT_DELIMITERS, ""), Str.trim);
            if (piece.length === 0) continue;
            const isUrl = Str.startsWith("http")(piece);
            expect(isUrl ? out.html : htmlText).toContain(
              isUrl ? `href="${escapeHtml(piece)}"` : piece,
            );
          }

        for (const part of [out.subject, out.html, out.text])
          for (const bad of LEFTOVERS) expect(part).not.toContain(bad);
        expect(out.text).not.toMatch(HTML_TAG);
        expect(out.html).not.toContain(NBSP);
        expect(out.html).not.toMatch(UNSAFE_HTML);
      });
    }
  }

  test("account emails carry the Kvitbit tile, workspace emails the Workspace initials and accent", () => {
    const e02 = renderEmail(fixtures.E02, "cs").html;
    expect(e02).toContain(">K</div>");
    expect(e02).toContain("background:#111111");
    const e05 = renderEmail(fixtures.E05, "cs").html;
    expect(e05).toContain(">AK</div>");
    expect(e05).toContain(`bgcolor="${workspace.accent.color}"`);
    expect(e05).toContain("color:#FFFFFF");
  });

  test("an invalid accent falls back to brand ink instead of reaching the CSS", () => {
    const html = renderEmail(
      {
        ...fixtures.E04,
        workspace: { name: "X", accent: { color: "red;background:url(x)", onColor: "#FFFFFF" } },
      },
      "en",
    ).html;
    expect(html).not.toContain("url(x)");
    expect(html).toContain('bgcolor="#111111"');
  });
});

describe("HTML escaping of injected values", () => {
  const evil = `<script>alert("x")</script> & 'Co' "Ltd"`;

  test("names, notes, messages and subjects are escaped in HTML and kept verbatim in text", () => {
    const out = renderEmail(
      {
        id: "E05",
        workspace: { name: evil },
        documentKind: "invoice",
        documentNumber: "<b>1</b>",
        amount: money("1"),
        shareUrl: "https://kvitbit.app/i/a?x=1&y=2",
        subject: `Subj ${evil}`,
        message: `Line one ${evil}\nLine two\n\nSecond paragraph`,
        footer: { replyTo: `a"b@c.cz` },
      },
      "cs",
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<b>1</b>");
    expect(out.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39; &quot;Ltd&quot;",
    );
    expect(out.html).toContain('href="https://kvitbit.app/i/a?x=1&amp;y=2"');
    expect(out.html).toContain("Line two");
    expect(out.html).toMatch(CUSTOM_MESSAGE_HTML);
    expect(out.html).toContain("a&quot;b@c.cz");
    expect(out.subject).toBe(`Subj ${evil}`);
    expect(out.text).toContain(evil);
  });

  test("E08 reason and schedule name, E04 inviter are escaped", () => {
    const e08 = renderEmail(
      {
        ...fixtures.E08,
        reason: evil,
        scheduleName: evil,
      },
      "en",
    ).html;
    const e04 = renderEmail({ ...fixtures.E04, inviterName: evil }, "cs").html;
    for (const html of [e08, e04]) {
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    }
  });

  test("non-http(s) links never reach the email", () => {
    const out = renderEmail(
      { id: "E01", variant: "already_registered", url: "javascript:alert(1)" },
      "en",
    );
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain('href="#"');
    expect(out.text).not.toContain("javascript:");
  });
});

describe("formatting", () => {
  test("money: cs uses NBSP groups and NBSP before the sign; en puts the code first", () => {
    expect(formatMoney(money("12345"), "cs")).toBe(nb("12_345,00_Kč"));
    expect(formatMoney(money("12345"), "en")).toBe(nb("CZK_12,345.00"));
    expect(formatMoney(money("1234567.891"), "cs")).toBe(nb("1_234_567,89_Kč"));
    expect(formatMoney(money("0.005"), "en")).toBe(nb("CZK_0.01"));
    expect(formatMoney(money("-1234.5", "EUR"), "cs")).toBe(nb("-1_234,50_€"));
    expect(formatMoney(money("-1234.5", "EUR"), "en")).toBe(nb("-EUR_1,234.50"));
    expect(formatMoney(money("999", "USD"), "cs")).toBe(nb("999,00_USD"));
    expect(formatMoney(money("1500", "JPY"), "cs")).toBe(nb("1_500_JPY"));
    expect(formatMoney(money("1500", "JPY"), "en")).toBe(nb("JPY_1,500"));
    expect(formatMoney(money("0"), "cs")).toBe(nb("0,00_Kč"));
  });

  test("dates", () => {
    expect(formatDate(IsoDate.make("2026-11-16"), "cs")).toBe(nb("16._11._2026"));
    expect(formatDate(IsoDate.make("2026-01-05"), "cs")).toBe(nb("5._1._2026"));
    expect(formatDate(IsoDate.make("2026-11-16"), "en")).toBe(nb("16_Nov_2026"));
    expect(formatDate(IsoDate.make("2026-01-05"), "en")).toBe(nb("5_Jan_2026"));
  });

  test("durations use Czech plural forms", () => {
    expect(formatDuration(1, "cs")).toBe(nb("1_minutu"));
    expect(formatDuration(3, "cs")).toBe(nb("3_minuty"));
    expect(formatDuration(15, "cs")).toBe(nb("15_minut"));
    expect(formatDuration(120, "cs")).toBe(nb("2_hodiny"));
    expect(formatDuration(1440 * 7, "cs")).toBe(nb("7_dní"));
    expect(formatDuration(1440 * 2, "cs")).toBe(nb("2_dny"));
    expect(formatDuration(90, "en")).toBe(nb("90_minutes"));
    expect(formatDuration(60, "en")).toBe(nb("1_hour"));
  });

  test("file sizes", () => {
    expect(formatFileSize(65_000, "cs")).toBe(nb("64_KB"));
    expect(formatFileSize(1, "en")).toBe(nb("1_KB"));
    expect(formatFileSize(1_572_864, "cs")).toBe(nb("1,5_MB"));
    expect(formatFileSize(1_572_864, "en")).toBe(nb("1.5_MB"));
  });

  test("HTML writes NBSP as &nbsp;; text keeps U+00A0", () => {
    const out = renderEmail(fixtures.E05, "cs");
    expect(out.html).toContain("58&nbsp;100,00&nbsp;Kč");
    expect(out.text).toContain(nb("58_100,00_Kč"));
  });
});

describe("document kinds in E05", () => {
  const { paymentQr: _qr, ...base } = fixtures.E05;
  test.each([
    ["proforma", "cs", "Zálohová faktura 2026-0042", "Zobrazit zálohovou fakturu a QR kód"],
    ["payment_tax_document", "cs", "Daňový doklad k přijaté platbě 2026-0042", "Přijatá platba"],
    ["credit_note", "cs", "Opravný daňový doklad 2026-0042", "Zobrazit opravný daňový doklad:"],
    ["credit_note", "en", "Credit note 2026-0042", "Credit amount"],
  ] as const)("%s %s", (kind, locale, subjectStart, textFragment) => {
    const qr = kind === "proforma" ? { paymentQr: "spayd" as const } : {};
    const out = renderEmail({ ...base, ...qr, documentKind: kind }, locale);
    expect(Str.startsWith(subjectStart)(out.subject)).toBe(true);
    expect(out.text).toContain(textFragment);
    expect(Str.includes("QR")(out.text)).toBe(kind === "proforma");
  });
});

describe("payment QR wording follows the document's actual QR", () => {
  const e05 = fixtures.E05;
  const e06 = fixtures.E06;
  const { paymentQr: _a, ...e05NoQr } = e05;
  const { paymentQr: _b, ...e06NoQr } = e06;

  test("no QR: no QR promise in E05 or E06, cs and en", () => {
    for (const locale of ["cs", "en"] as const)
      for (const out of [
        renderEmail(e05NoQr, locale),
        renderEmail({ ...e05NoQr, amount: money("10", "USD") }, locale),
        renderEmail(e06NoQr, locale),
      ]) {
        expect(out.text).not.toContain("QR");
        expect(out.html).not.toContain("QR");
      }
    expect(renderEmail(e05NoQr, "cs").text).toContain("Online náhled s platebními údaji");
    expect(renderEmail(e05NoQr, "en").text).toContain("view payment details online:");
    expect(renderEmail(e06NoQr, "cs").text).toContain("Otevřít fakturu:\n");
  });

  test("EPC (EUR) says QR code, never the Czech QR Platba brand", () => {
    const eur = { amount: money("1200", "EUR"), paymentQr: "epc" as const };
    const cs05 = renderEmail({ ...e05, ...eur }, "cs").text;
    expect(cs05).toContain("včetně QR kódu pro platbu");
    expect(cs05).toContain("Zobrazit fakturu a QR kód:");
    expect(cs05).not.toContain("QR Platb");
    const cs06 = renderEmail({ ...e06, amountDue: eur.amount, paymentQr: "epc" }, "cs").text;
    expect(cs06).toContain("Otevřít fakturu a QR kód:");
    expect(cs06).not.toContain("QR Platb");
    expect(renderEmail({ ...e05, ...eur }, "en").text).toContain("View invoice & QR code:");
  });

  test("SPAYD (CZK) uses QR Platba in cs", () => {
    expect(renderEmail(e05, "cs").text).toContain("včetně QR Platby");
    expect(renderEmail(e06, "cs").text).toContain("Otevřít fakturu a QR Platbu:");
  });
});

describe("subjects and overrides", () => {
  const e05 = fixtures.E05;

  test("line breaks in interpolated names and overrides collapse to one header line", () => {
    // biome-ignore lint/security/noSecrets: This sample company name contains a CRLF for the header test.
    const out = renderEmail({ ...e05, workspace: { name: "Ateliér\r\nKalný" } }, "cs");
    expect(out.subject).toBe(nb("Faktura 2026-0042 — Ateliér Kalný (58_100,00_Kč)"));
    expect(renderEmail({ ...e05, subject: " A\n\nB " }, "en").subject).toBe("A B");
    const e04 = fixtures.E04;
    expect(renderEmail({ ...e04, inviterName: "Filip\nKalný" }, "en").subject).not.toMatch(
      HEADER_LINE_BREAK,
    );
  });

  test("blank subject and message overrides fall back to the defaults", () => {
    const out = renderEmail({ ...e05, subject: "  \n ", message: " \n\n " }, "cs");
    expect(Str.startsWith("Faktura 2026-0042")(out.subject)).toBe(true);
    expect(out.text).toContain("v příloze zasíláme fakturu 2026-0042");
  });
});

describe("dark mode", () => {
  test("Kvitbit ink accents carry the dark-mode swap; workspace accents do not", () => {
    const account = renderEmail(fixtures.E03, "cs").html;
    expect(account).toContain(".kb-accent{background:#FAFAFA!important;}");
    expect(account).toContain(".kb-link{color:#FAFAFA!important;}");
    expect(Str.split(account, 'class="kb-accent"').length - 1).toBe(2); // stripe and button cell
    expect(Str.split(account, 'class="kb-on-accent"').length - 1).toBe(2); // tile and button text
    expect(account).toContain('class="kb-link"');
    const ws = renderEmail(fixtures.E05, "cs").html;
    expect(ws).not.toContain('class="kb-accent"');
    expect(ws).not.toContain('class="kb-on-accent"');
    const pill = renderEmail(fixtures.E08, "en").html;
    expect(pill).toContain('class="kb-error"');
  });
});

describe("review round 1 regressions", () => {
  test("initials keep astral letters whole and the HTML stays well-formed", () => {
    const e04 = fixtures.E04;
    // biome-ignore lint/security/noSecrets: Sample Japanese company names exercise astral characters.
    for (const name of ["𠮷田商店", "𠮷田 商店", "s.r.o."]) {
      const html = renderEmail({ ...e04, workspace: { name } }, "cs").html;
      // No lone surrogate (String#isWellFormed is outside this repo's TS lib).
      expect(html).not.toMatch(LONE_SURROGATE);
    }
    expect(renderEmail({ ...e04, workspace: { name: "𠮷田 商店" } }, "cs").html).toContain(
      ">𠮷商</div>",
    );
  });

  test("long unbroken values may wrap inside the card", () => {
    const html = renderEmail(
      {
        ...fixtures.E02,
        email: `${Str.repeat(60)("a")}@example.com`,
      },
      "en",
    ).html;
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toMatch(WRAPPED_EMAIL);
  });

  test("E08 wording does not assume an Invoice", () => {
    for (const locale of ["cs", "en"] as const) {
      const out = renderEmail(fixtures.E08, locale);
      expect(out.subject + out.text).not.toMatch(INVOICE_WORDING);
    }
  });

  test("E06 uses the workspace reminder subject and message", () => {
    const out = renderEmail(
      {
        ...fixtures.E06,
        subject: "Custom reminder <2026-0042>",
        message: "First custom paragraph.\n\nSecond & last.",
      },
      "en",
    );
    expect(out.subject).toBe("Custom reminder <2026-0042>");
    expect(out.text).toContain("First custom paragraph.\n\nSecond & last.");
    expect(out.text).not.toContain("We have not yet received payment");
    expect(out.html).toContain("First custom paragraph.");
    expect(out.html).toContain("Second &amp; last.");
    expect(out.html).toContain("<title>Custom reminder &lt;2026-0042&gt;</title>");
    expect(out.html).not.toContain("We have not yet received payment");
  });
});
