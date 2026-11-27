/**
 * Copy and structure of the transactional emails E01-E08 (docs/design/user-flows.md, "Emails";
 * approved mockup screen 25). Each builder maps typed input to the shared content model.
 */
import type { DocumentKind, IsoDate, Locale, Money, Role } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { formatDate, formatDays, formatDuration, formatFileSize, formatMoney } from "./format";
import { type Block, type Brand, type EmailContent, type Inline, kvitbitBrand } from "./layout";

// Inputs -------------------------------------------------------------------------------------

/** Workspace branding colour pair (`primary` / `onPrimary`), `#RRGGBB`. Invalid values fall back to brand ink. */
export interface EmailAccent {
  readonly color: string;
  readonly onColor: string;
}

/** The Workspace (Issuing Entity) a workspace email is sent for. */
export interface EmailWorkspace {
  /** Issuing Entity name, e.g. "Ateliér Kalný s.r.o.". */
  readonly name: string;
  readonly accent?: EmailAccent;
}

/** Statutory footer of recipient-facing document emails. */
export interface EmailIssuerFooter {
  /** One-line address, e.g. "Křižíkova 185/35, Praha 8". */
  readonly address?: string;
  /** IČO. */
  readonly companyId?: string;
  readonly replyTo?: string;
}

/** E01 Verify your email (flow 1.2). */
export interface E01Verify {
  readonly id: "E01";
  readonly variant: "verify";
  readonly url: string;
  readonly validForMinutes: number;
}

/** E01 variant sent when the address already has an account (no enumeration in the UI). */
export interface E01AlreadyRegistered {
  readonly id: "E01";
  readonly variant: "already_registered";
  /** Login page. */
  readonly url: string;
}

/** E02 Magic link (flow 1.4). */
export interface E02MagicLink {
  readonly id: "E02";
  readonly email: string;
  readonly url: string;
  readonly validForMinutes: number;
  /** Where the request came from, e.g. "Praha, CZ (Chrome · Linux)". */
  readonly requestedFrom?: string;
}

/** E03 Password reset (flow 1.6). */
export interface E03PasswordReset {
  readonly id: "E03";
  readonly email: string;
  readonly url: string;
  readonly validForMinutes: number;
  /** Passkey-only accounts: the email also offers a magic link login. */
  readonly magicLinkUrl?: string;
}

/** E04 Workspace invitation (flow 2.4). */
export interface E04Invitation {
  readonly id: "E04";
  readonly workspace: EmailWorkspace;
  readonly inviterName: string;
  readonly inviteeEmail: string;
  /** Invitations grant admin, member or accountant; ownership moves only by transfer. */
  readonly role: Exclude<Role, "owner">;
  readonly url: string;
  readonly validForDays: number;
  readonly expiresOn: IsoDate;
}

/** E05 Document delivery (flows 3.3, 4.4). */
export interface E05DocumentDelivery {
  readonly id: "E05";
  readonly workspace: EmailWorkspace;
  readonly documentKind: DocumentKind;
  readonly documentNumber: string;
  /** Amount due (Invoice, Proforma), amount received (Payment Tax Document), or credited amount. */
  readonly amount: Money;
  readonly dueDate?: IsoDate;
  readonly variableSymbol?: string;
  readonly bankAccount?: string;
  /** Public Share Link; the email always carries it. */
  readonly shareUrl: string;
  /** Format of the document's payment QR (`DocumentView.paymentQr.format`); absent when it has none. */
  readonly paymentQr?: "spayd" | "epc";
  readonly attachment?: { readonly filename: string; readonly sizeBytes: number };
  /** Workspace email text for this kind and language (flow 10.6), placeholders already resolved. */
  readonly subject?: string;
  readonly message?: string;
  readonly footer: EmailIssuerFooter;
}

/** E06 Overdue reminder (flows 7.3, 7.4). */
export interface E06OverdueReminder {
  readonly id: "E06";
  readonly workspace: EmailWorkspace;
  readonly documentKind: "invoice" | "proforma";
  readonly documentNumber: string;
  readonly amountDue: Money;
  readonly dueDate: IsoDate;
  readonly daysOverdue: number;
  readonly variableSymbol?: string;
  readonly shareUrl: string;
  /** Format of the document's payment QR; absent when it has none. */
  readonly paymentQr?: "spayd" | "epc";
  /** Workspace reminder text (flow 7.5), placeholders already resolved. */
  readonly subject?: string;
  readonly message?: string;
  readonly footer: Pick<EmailIssuerFooter, "replyTo">;
}

/** E07 Confirm email change, sent to the new address (flow 1.8). */
export interface E07ConfirmNew {
  readonly id: "E07";
  readonly variant: "confirm_new";
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly url: string;
  readonly validForMinutes: number;
}

/** E07 notice to the old address. */
export interface E07NoticeOld {
  readonly id: "E07";
  readonly variant: "notice_old";
  readonly newEmail: string;
  /** Account security settings. */
  readonly url: string;
}

/** E08 Needs attention: a Recurring Schedule run could not issue (flow 4.4), to owners and admins. */
export interface E08NeedsAttention {
  readonly id: "E08";
  readonly workspaceName: string;
  readonly scheduleName: string;
  readonly occurrenceDate: IsoDate;
  /** Why the run fell back to a Draft, already in the email's language. */
  readonly reason: string;
  readonly url: string;
}

export type EmailTemplate =
  | E01Verify
  | E01AlreadyRegistered
  | E02MagicLink
  | E03PasswordReset
  | E04Invitation
  | E05DocumentDelivery
  | E06OverdueReminder
  | E07ConfirmNew
  | E07NoticeOld
  | E08NeedsAttention;

export type EmailTemplateId = EmailTemplate["id"];

// Helpers ------------------------------------------------------------------------------------

const HEX = /^#[0-9A-Fa-f]{6}$/;
const WHITESPACE = /\s+/;
const STARTS_WITH_LETTER = /^\p{L}/u;
const BLANK_LINES = /\n{2,}/;
const INDEFINITE_ARTICLE = /^an? /;

/** Up to two initials from the name's words, skipping legal suffixes such as "s.r.o.". */
const initialsOf = (name: string): string => {
  // Array.from splits by code point, so astral letters (𠮷) stay whole.
  const first = (word: string): string | undefined => Arr.fromIterable(word)[0];
  const uppercase = Str.toLocaleUpperCase();
  const initials = Fn.pipe(
    Str.split(name, WHITESPACE),
    Arr.filter((word) => STARTS_WITH_LETTER.test(word) && !Str.includes(".")(word)),
    Arr.take(2),
    Arr.map((word) => uppercase(first(word) ?? "")),
    Arr.join(""),
  );
  return initials.length > 0 ? initials : uppercase(first(Str.trim(name)) ?? "K");
};

const workspaceBrand = (ws: EmailWorkspace): Brand => {
  const accent = ws.accent;
  const valid = accent !== undefined && HEX.test(accent.color) && HEX.test(accent.onColor);
  return {
    name: ws.name,
    initials: initialsOf(ws.name),
    accent: valid ? accent.color : kvitbitBrand.accent,
    onAccent: valid ? accent.onColor : kvitbitBrand.onAccent,
  };
};

/** A caller override that is empty or whitespace counts as absent. */
const nonBlank = (value: string | undefined): string | undefined =>
  value === undefined || Str.trim(value).length === 0 ? undefined : value;

const by = <A>(locale: Locale, cs: A, en: A): A => (locale === "cs" ? cs : en);

const p = (...parts: ReadonlyArray<Inline>): Block => ({ _tag: "Paragraph", parts });
const muted = (...parts: ReadonlyArray<Inline>): Block => ({ _tag: "Muted", parts });
const h = (text: string): Block => ({ _tag: "Heading", text });
const button = (label: string, url: string): Block => ({ _tag: "Button", label, url });
const mono = (text: string): Inline => ({ mono: text });
const strong = (text: string): Inline => ({ strong: text });
const br: Inline = { br: true };

/** A custom Workspace message as paragraphs separated by blank lines. */
const messageBlocks = (message: string): ReadonlyArray<Block> =>
  Fn.pipe(
    message,
    Str.replace(/\r\n?/g, "\n"),
    Str.split(BLANK_LINES),
    Arr.map(Str.trim),
    Arr.filter((part) => part.length > 0),
    Arr.map((part) => p(part)),
  );

const sentBy = (locale: Locale): string =>
  by(locale, "Odesláno službou Kvitbit", "Sent by Kvitbit");

const issuerFooter = (
  locale: Locale,
  ws: EmailWorkspace,
  footer: EmailIssuerFooter,
): ReadonlyArray<string> => [
  ws.name,
  ...(footer.address === undefined ? [] : [footer.address]),
  ...(footer.companyId === undefined ? [] : [`${by(locale, "IČO", "ID")} ${footer.companyId}`]),
  ...(footer.replyTo === undefined ? [] : [`Reply-To: ${footer.replyTo}`]),
];

interface KindCopy {
  /** Title case name: "Faktura". */
  readonly name: string;
  /** cs accusative ("zasíláme fakturu"); en lower case ("view invoice"). */
  readonly object: string;
  /** cs genitive ("úhradu faktury"); en lower case. */
  readonly of: string;
  readonly amountLabel: string;
  readonly payable: boolean;
}

const kindCopy = (kind: DocumentKind, locale: Locale): KindCopy => {
  switch (kind) {
    case "invoice":
      return by(
        locale,
        {
          name: "Faktura",
          object: "fakturu",
          of: "faktury",
          amountLabel: "Částka k úhradě",
          payable: true,
        },
        {
          name: "Invoice",
          object: "invoice",
          of: "invoice",
          amountLabel: "Total due",
          payable: true,
        },
      );
    case "proforma":
      return by(
        locale,
        {
          name: "Zálohová faktura",
          object: "zálohovou fakturu",
          of: "zálohové faktury",
          amountLabel: "Částka k úhradě",
          payable: true,
        },
        {
          name: "Proforma invoice",
          object: "proforma invoice",
          of: "proforma invoice",
          amountLabel: "Total due",
          payable: true,
        },
      );
    case "payment_tax_document":
      return by(
        locale,
        {
          name: "Daňový doklad k přijaté platbě",
          object: "daňový doklad k přijaté platbě",
          of: "daňového dokladu",
          amountLabel: "Přijatá platba",
          payable: false,
        },
        {
          name: "Tax document for received payment",
          object: "tax document",
          of: "tax document",
          amountLabel: "Payment received",
          payable: false,
        },
      );
    case "credit_note":
      return by(
        locale,
        {
          name: "Opravný daňový doklad",
          object: "opravný daňový doklad",
          of: "opravného daňového dokladu",
          amountLabel: "Částka opravy",
          payable: false,
        },
        {
          name: "Credit note",
          object: "credit note",
          of: "credit note",
          amountLabel: "Credit amount",
          payable: false,
        },
      );
  }
};

const ROLE_COPY: Readonly<
  Record<
    Role,
    { readonly cs: string; readonly csScope: string; readonly en: string; readonly enScope: string }
  >
> = {
  owner: {
    cs: "Vlastník",
    csScope: "plná správa prostoru, týmu a nastavení",
    en: "an Owner",
    enScope: "full control of the workspace, team and settings",
  },
  admin: {
    cs: "Administrátor",
    csScope: "správa dokladů, týmu a nastavení",
    en: "an Admin",
    enScope: "manage documents, team and settings",
  },
  member: {
    cs: "Člen",
    csScope: "vystavování dokladů, náklady, kontakty",
    en: "a Member",
    enScope: "issue documents, track expenses, manage contacts",
  },
  accountant: {
    cs: "Účetní",
    csScope: "pouze čtení a stahování",
    en: "an Accountant",
    enScope: "read-only access and downloads",
  },
};

const roleLabel = (
  role: Role,
  locale: Locale,
): { readonly name: string; readonly scope: string } => {
  const r = ROLE_COPY[role];
  return locale === "cs"
    ? { name: r.cs, scope: r.csScope }
    : { name: Str.replace(INDEFINITE_ARTICLE, "")(r.en), scope: r.enScope };
};

// Builders -----------------------------------------------------------------------------------

const e01 = (t: E01Verify | E01AlreadyRegistered, locale: Locale): EmailContent => {
  if (t.variant === "verify") {
    const validFor = formatDuration(t.validForMinutes, locale);
    return {
      locale,
      brand: kvitbitBrand,
      subject: by(
        locale,
        "Potvrďte svou e-mailovou adresu — Kvitbit",
        "Verify your email address — Kvitbit",
      ),
      preheader: by(locale, "Dokončete registraci v Kvitbitu.", "Finish signing up for Kvitbit."),
      blocks: [
        h(by(locale, "Potvrďte svůj e-mail", "Confirm your email")),
        by(
          locale,
          p(
            "Dobrý den, děkujeme za registraci v ",
            strong("Kvitbitu"),
            ". Pro aktivaci účtu klikněte na tlačítko níže:",
          ),
          p(
            "Hello, thanks for signing up for ",
            strong("Kvitbit"),
            ". Click below to activate your account:",
          ),
        ),
        button(by(locale, "Ověřit e-mailovou adresu", "Verify email address"), t.url),
        muted(
          by(
            locale,
            `Odkaz platí ${validFor}. Pokud jste účet nezakládali, tento e-mail můžete bezpečně smazat.`,
            `This link expires in ${validFor}. If you didn't request an account, you can safely ignore this email.`,
          ),
        ),
      ],
      footer: [sentBy(locale), by(locale, "Zabezpečení účtu", "Account security")],
    };
  }
  return {
    locale,
    brand: kvitbitBrand,
    subject: by(locale, "Pokus o registraci v Kvitbitu", "Sign-up attempt on Kvitbit"),
    preheader: by(locale, "Váš účet zůstal beze změny.", "Nothing was changed on your account."),
    blocks: [
      h(by(locale, "Účet s tímto e-mailem už existuje", "An account already exists")),
      p(
        by(
          locale,
          "Někdo se pokusil založit nový účet Kvitbit na vaši e-mailovou adresu. Váš stávající účet zůstal beze změny.",
          "Someone tried to register a new Kvitbit account using your email address. Nothing was changed on your existing account.",
        ),
      ),
      button(by(locale, "Přihlásit se do účtu", "Sign in to your account"), t.url),
      muted(
        by(
          locale,
          "Zapomněli jste heslo? Na přihlašovací stránce můžete požádat o jednorázový odkaz nebo obnovení hesla.",
          "Forgot your password? Use a sign-in link or password reset from the sign-in screen.",
        ),
      ),
    ],
    footer: [
      sentBy(locale),
      by(locale, "Ochrana soukromí při registraci", "Sign-up privacy notice"),
    ],
  };
};

const e02 = (t: E02MagicLink, locale: Locale): EmailContent => {
  const validFor = formatDuration(t.validForMinutes, locale);
  const origin =
    t.requestedFrom === undefined
      ? ""
      : by(locale, ` Místo požadavku: ${t.requestedFrom}.`, ` Requested from ${t.requestedFrom}.`);
  return {
    locale,
    brand: kvitbitBrand,
    subject: by(
      locale,
      "Jednorázový odkaz pro přihlášení do Kvitbitu",
      "Your one-time sign-in link for Kvitbit",
    ),
    preheader: by(locale, `Odkaz platí ${validFor}.`, `The link is valid for ${validFor}.`),
    blocks: [
      h(by(locale, "Přihlášení jedním kliknutím", "Sign in with one click")),
      by(
        locale,
        p("Klikněte na tlačítko níže pro bezpečné přihlášení k účtu ", mono(t.email), ":"),
        p("Click below to sign in to ", mono(t.email), ":"),
      ),
      button(by(locale, "Přihlásit se do Kvitbitu", "Sign in to Kvitbit"), t.url),
      muted(
        by(
          locale,
          `Odkaz je jednorázový a platí ${validFor}.${origin}`,
          `Single-use link valid for ${validFor}.${origin}`,
        ),
      ),
    ],
    footer: [
      sentBy(locale),
      by(
        locale,
        "Pokud jste přihlášení nevyžádali, odkaz neotvírejte.",
        "If you didn't request this link, you can ignore this email.",
      ),
    ],
  };
};

const e03 = (t: E03PasswordReset, locale: Locale): EmailContent => {
  const validFor = formatDuration(t.validForMinutes, locale);
  return {
    locale,
    brand: kvitbitBrand,
    subject: by(locale, "Obnovení hesla k účtu Kvitbit", "Reset your Kvitbit password"),
    preheader: by(locale, `Odkaz platí ${validFor}.`, `The link expires in ${validFor}.`),
    blocks: [
      h(by(locale, "Nastavení nového hesla", "Choose a new password")),
      by(
        locale,
        p("Obdrželi jsme žádost o změnu hesla pro účet ", mono(t.email), "."),
        p("We received a password reset request for ", mono(t.email), "."),
      ),
      button(by(locale, "Nastavit nové heslo", "Reset password"), t.url),
      ...(t.magicLinkUrl === undefined
        ? []
        : [
            {
              _tag: "Link",
              label: by(
                locale,
                "Nebo se přihlaste jednorázovým odkazem",
                "Or sign in with a one-time link",
              ),
              url: t.magicLinkUrl,
            } satisfies Block,
          ]),
      muted(
        by(
          locale,
          `Odkaz platí ${validFor}. Po uložení nového hesla budou odhlášena všechna ostatní zařízení.`,
          `Expires in ${validFor}. Setting a new password signs out all other active sessions.`,
        ),
      ),
    ],
    footer: [sentBy(locale), by(locale, "Zabezpečení účtu", "Account security")],
  };
};

const e04 = (t: E04Invitation, locale: Locale): EmailContent => {
  const role = roleLabel(t.role, locale);
  const [article] = Str.split(ROLE_COPY[t.role].en, " ");
  const days = formatDays(locale)(t.validForDays);
  const until = formatDate(t.expiresOn, locale);
  return {
    locale,
    brand: workspaceBrand(t.workspace),
    subject: by(
      locale,
      `${t.inviterName} vás zve do prostoru ${t.workspace.name}`,
      `${t.inviterName} invited you to ${t.workspace.name}`,
    ),
    preheader: by(locale, `Pozvánka platí do ${until}.`, `The invitation expires on ${until}.`),
    blocks: [
      h(by(locale, "Pozvánka do pracovního prostoru", "You're invited to a workspace")),
      by(
        locale,
        p(
          strong(t.inviterName),
          " vás zve do prostoru ",
          strong(t.workspace.name),
          " s rolí ",
          strong(role.name),
          ` (${role.scope}).`,
        ),
        p(
          strong(t.inviterName),
          " invited you to join ",
          strong(t.workspace.name),
          ` as ${article} `,
          strong(role.name),
          ` (${role.scope}).`,
        ),
      ),
      button(by(locale, "Přijmout pozvánku", "Accept invitation"), t.url),
      by(
        locale,
        muted(
          "Pozvánka je vázána na adresu ",
          mono(t.inviteeEmail),
          ` a platí ${days} (do ${until}).`,
        ),
        muted("Locked to ", mono(t.inviteeEmail), ` · expires in ${days} (${until}).`),
      ),
    ],
    footer: [
      by(
        locale,
        `Odesláno službou Kvitbit jménem ${t.workspace.name}`,
        `Sent via Kvitbit on behalf of ${t.workspace.name}`,
      ),
    ],
  };
};

const e05 = (t: E05DocumentDelivery, locale: Locale): EmailContent => {
  const kind = kindCopy(t.documentKind, locale);
  const amount = formatMoney(t.amount, locale);
  const defaultMessage: Block = by(
    locale,
    p(
      "Dobrý den,",
      br,
      `${t.attachment === undefined ? "zasíláme" : "v příloze zasíláme"} ${kind.object} ${t.documentNumber}. ` +
        (t.paymentQr === "spayd"
          ? "Online náhled včetně QR Platby je dostupný na odkazu níže."
          : t.paymentQr === "epc"
            ? "Online náhled včetně QR kódu pro platbu je dostupný na odkazu níže."
            : kind.payable
              ? "Online náhled s platebními údaji je dostupný na odkazu níže."
              : "Online náhled je dostupný na odkazu níže."),
    ),
    p(
      "Hello,",
      br,
      `${t.attachment === undefined ? "Here is your" : "Please find attached your"} ${kind.object} ${t.documentNumber}. ` +
        (t.paymentQr !== undefined
          ? "You can also view payment details and the QR code online:"
          : kind.payable
            ? "You can also view payment details online:"
            : "You can also view it online:"),
    ),
  );
  const summary: Array<{ label: string; value: string; mono?: boolean; emphasis?: boolean }> = [
    { label: kind.amountLabel, value: amount, emphasis: true },
  ];
  if (t.dueDate !== undefined)
    summary.push({
      label: by(locale, "Datum splatnosti", "Due date"),
      value: formatDate(t.dueDate, locale),
      mono: true,
    });
  if (t.variableSymbol !== undefined)
    summary.push({
      label: by(locale, "Variabilní symbol", "Variable symbol"),
      value: t.variableSymbol,
      mono: true,
    });
  if (t.bankAccount !== undefined)
    summary.push({
      label: by(locale, "Bankovní účet", "Bank account"),
      value: t.bankAccount,
      mono: true,
    });
  return {
    locale,
    brand: workspaceBrand(t.workspace),
    subject:
      nonBlank(t.subject) ?? `${kind.name} ${t.documentNumber} — ${t.workspace.name} (${amount})`,
    preheader: `${kind.amountLabel}: ${amount}`,
    blocks: [
      h(
        by(
          locale,
          `Zasíláme ${kind.object} č. ${t.documentNumber}`,
          `${kind.name} ${t.documentNumber}`,
        ),
      ),
      ...(nonBlank(t.message) === undefined ? [defaultMessage] : messageBlocks(t.message ?? "")),
      { _tag: "Summary", items: summary },
      ...(t.attachment === undefined
        ? []
        : [
            {
              _tag: "Attachment",
              filename: t.attachment.filename,
              size: formatFileSize(t.attachment.sizeBytes, locale),
            } satisfies Block,
          ]),
      button(
        by(
          locale,
          `Zobrazit ${kind.object}${t.paymentQr === undefined ? "" : " a QR kód"}`,
          `View ${kind.object}${t.paymentQr === undefined ? "" : " & QR code"}`,
        ),
        t.shareUrl,
      ),
    ],
    footer: issuerFooter(locale, t.workspace, t.footer),
  };
};

const e06 = (t: E06OverdueReminder, locale: Locale): EmailContent => {
  const kind = kindCopy(t.documentKind, locale);
  const amount = formatMoney(t.amountDue, locale);
  const overdue = by(
    locale,
    `${formatDays(locale)(t.daysOverdue)} po splatnosti`,
    `${formatDays(locale)(t.daysOverdue)} overdue`,
  );
  const due = formatDate(t.dueDate, locale);
  const defaultMessage: Block = by(
    locale,
    p(
      "Dobrý den,",
      br,
      `zatím jsme nezaznamenali úhradu ${kind.of} `,
      mono(t.documentNumber),
      ` se splatností ${due}. Pokud jste platbu již odeslali, považujte prosím tento e-mail za bezpředmětný.`,
    ),
    p(
      "Hello,",
      br,
      `We have not yet received payment for ${kind.of} `,
      mono(t.documentNumber),
      ` (due ${due}). If you already sent the payment, please disregard this reminder.`,
    ),
  );
  return {
    locale,
    brand: workspaceBrand(t.workspace),
    subject:
      nonBlank(t.subject) ??
      by(
        locale,
        `Připomínka splatnosti ${kind.of} ${t.documentNumber} (${overdue})`,
        `Reminder: ${kind.name} ${t.documentNumber} is ${overdue}`,
      ),
    preheader: by(locale, `Zbývá uhradit ${amount}.`, `Amount overdue: ${amount}.`),
    blocks: [
      { _tag: "Pill", tone: "warn", text: overdue },
      h(
        by(
          locale,
          `Připomínka úhrady ${kind.of} ${t.documentNumber}`,
          `Payment reminder for ${t.documentNumber}`,
        ),
      ),
      ...(nonBlank(t.message) === undefined ? [defaultMessage] : messageBlocks(t.message ?? "")),
      {
        _tag: "Summary",
        items: [
          { label: by(locale, "Zbývá uhradit", "Amount overdue"), value: amount, emphasis: true },
          ...(t.variableSymbol === undefined
            ? []
            : [
                {
                  label: by(locale, "Variabilní symbol", "Variable symbol"),
                  value: t.variableSymbol,
                  mono: true,
                },
              ]),
        ],
      },
      button(
        by(
          locale,
          `Otevřít ${kind.object}${t.paymentQr === "spayd" ? " a QR Platbu" : t.paymentQr === "epc" ? " a QR kód" : ""}`,
          `Open ${kind.object}${t.paymentQr === undefined ? "" : " & QR payment"}`,
        ),
        t.shareUrl,
      ),
    ],
    footer: issuerFooter(locale, t.workspace, t.footer),
  };
};

const e07 = (t: E07ConfirmNew | E07NoticeOld, locale: Locale): EmailContent => {
  if (t.variant === "confirm_new") {
    const validFor = formatDuration(t.validForMinutes, locale);
    return {
      locale,
      brand: kvitbitBrand,
      subject: by(
        locale,
        "Potvrďte novou e-mailovou adresu — Kvitbit",
        "Confirm your new email address — Kvitbit",
      ),
      preheader: by(locale, `Odkaz platí ${validFor}.`, `The link expires in ${validFor}.`),
      blocks: [
        h(by(locale, "Potvrzení změny e-mailu", "Confirm email change")),
        by(
          locale,
          p(
            "Klikněte na tlačítko níže pro dokončení změny přihlašovacího e-mailu z ",
            mono(t.oldEmail),
            " na ",
            mono(t.newEmail),
            ".",
          ),
          p(
            "Click below to finish changing your sign-in email from ",
            mono(t.oldEmail),
            " to ",
            mono(t.newEmail),
            ".",
          ),
        ),
        button(by(locale, "Potvrdit nový e-mail", "Confirm new email"), t.url),
        muted(by(locale, `Odkaz platí ${validFor}.`, `Link expires in ${validFor}.`)),
      ],
      footer: [sentBy(locale), by(locale, "Zabezpečení účtu", "Account security")],
    };
  }
  return {
    locale,
    brand: kvitbitBrand,
    subject: by(
      locale,
      "Bezpečnostní upozornění: požadavek na změnu e-mailu",
      "Security alert: email change requested",
    ),
    preheader: by(
      locale,
      "Pokud jste to nebyli vy, zabezpečte účet.",
      "If this wasn't you, secure your account.",
    ),
    blocks: [
      { _tag: "Pill", tone: "warn", text: by(locale, "Bezpečnostní upozornění", "Security alert") },
      h(by(locale, "Byla vyžádána změna e-mailu", "Email change requested")),
      by(
        locale,
        p(
          "U vašeho účtu byla vyžádána změna e-mailu na ",
          mono(t.newEmail),
          ". Pokud jste tuto změnu neprovedli vy, ihned si změňte heslo a odhlaste ostatní zařízení.",
        ),
        p(
          "A request was made to change your account email to ",
          mono(t.newEmail),
          ". If this wasn't you, change your password and sign out other devices immediately.",
        ),
      ),
      button(by(locale, "Zkontrolovat zabezpečení účtu", "Review account security"), t.url),
    ],
    footer: [
      sentBy(locale),
      by(locale, "Oznámení na původní adresu", "Sent to your previous address"),
    ],
  };
};

const e08 = (t: E08NeedsAttention, locale: Locale): EmailContent => {
  const date = formatDate(t.occurrenceDate, locale);
  return {
    locale,
    brand: kvitbitBrand,
    subject: by(
      locale,
      `Vyžaduje pozornost: pravidelné vystavení dokladu selhalo (${t.workspaceName})`,
      `Action needed: recurring document run failed (${t.workspaceName})`,
    ),
    preheader: by(
      locale,
      "Místo dokladu vznikl koncept ke kontrole.",
      "A Draft was created for review instead.",
    ),
    blocks: [
      { _tag: "Pill", tone: "error", text: by(locale, "Vyžaduje pozornost", "Needs attention") },
      h(by(locale, "Pravidelný doklad nebyl vystaven", "Recurring document could not be issued")),
      by(
        locale,
        p(
          "Plán ",
          strong(t.scheduleName),
          ` se k datu ${date} nepodařilo automaticky vystavit. Místo toho vznikl koncept ke kontrole.`,
        ),
        p(
          "Schedule ",
          strong(t.scheduleName),
          ` failed to issue automatically for ${date}. A Draft was created for review instead.`,
        ),
      ),
      { _tag: "Note", label: by(locale, "Důvod chyby", "Reason"), text: t.reason },
      button(by(locale, "Opravit v Kvitbitu", "Resolve in Kvitbit"), t.url),
    ],
    footer: [
      by(
        locale,
        `Odesláno službou Kvitbit vlastníkům a administrátorům prostoru ${t.workspaceName}`,
        `Sent by Kvitbit to Owners & Admins of ${t.workspaceName}`,
      ),
    ],
  };
};

export const emailContent =
  (locale: Locale) =>
  (template: EmailTemplate): EmailContent => {
    switch (template.id) {
      case "E01":
        return e01(template, locale);
      case "E02":
        return e02(template, locale);
      case "E03":
        return e03(template, locale);
      case "E04":
        return e04(template, locale);
      case "E05":
        return e05(template, locale);
      case "E06":
        return e06(template, locale);
      case "E07":
        return e07(template, locale);
      case "E08":
        return e08(template, locale);
    }
  };
