/**
 * One content model per email, rendered twice: as 600px table-based HTML with inline styles
 * (approved mockup screen 25) and as the plain-text alternative. Every string in the model is
 * plain text; escaping happens only here, at the HTML boundary.
 */
import { brandColors } from "@kvitbit/brand";
import type { Locale } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

/** Inline text run. Plain strings are body text. */
export type Inline =
  | string
  | { readonly strong: string }
  | { readonly mono: string }
  | { readonly br: true };

interface SummaryItem {
  readonly label: string;
  readonly value: string;
  /** Identifiers (document numbers, VS, bank accounts, dates) use the mono stack. */
  readonly mono?: boolean;
  /** The amount: larger figure. */
  readonly emphasis?: boolean;
}

export type Block =
  | { readonly _tag: "Pill"; readonly tone: "warn" | "error"; readonly text: string }
  | { readonly _tag: "Heading"; readonly text: string }
  | { readonly _tag: "Paragraph"; readonly parts: ReadonlyArray<Inline> }
  | { readonly _tag: "Summary"; readonly items: ReadonlyArray<SummaryItem> }
  | { readonly _tag: "Note"; readonly label: string; readonly text: string }
  | { readonly _tag: "Attachment"; readonly filename: string; readonly size: string }
  | { readonly _tag: "Button"; readonly label: string; readonly url: string }
  | { readonly _tag: "Muted"; readonly parts: ReadonlyArray<Inline> }
  | { readonly _tag: "Link"; readonly label: string; readonly url: string };

/** Header identity: Kvitbit for account emails, the Workspace for workspace emails. */
export interface Brand {
  readonly name: string;
  readonly initials: string;
  readonly accent: string;
  readonly onAccent: string;
  /** Brand ink: swaps to the dark-surface ink in dark mode so it stays visible on the dark card. */
  readonly invertInDark?: boolean;
}

export interface EmailContent {
  readonly locale: Locale;
  readonly subject: string;
  /** Inbox preview line, hidden in the body. */
  readonly preheader: string;
  readonly brand: Brand;
  readonly blocks: ReadonlyArray<Block>;
  /** Footer segments, joined with " · ". */
  readonly footer: ReadonlyArray<string>;
}

/**
 * Graphite Atelier light/dark surface roles (DESIGN.md "Color Architecture") and the warning and
 * error pill colours from the approved mockup. Brand ink comes from @kvitbit/brand.
 */
const palette = {
  canvas: "#EFEFF1",
  card: "#FFFFFF",
  sub: "#F4F4F5",
  fg: "#09090B",
  muted: "#52525B",
  border: "#D4D4D8",
  warnBg: "#FEF3C7",
  warnFg: "#B45309",
  errBg: "#FEE2E2",
  errFg: "#991B1B",
  dark: {
    canvas: "#09090B",
    card: "#131316",
    sub: "#18181C",
    fg: "#FAFAFA",
    muted: "#A1A1AA",
    border: "#27272A",
    warnBg: "#32220F",
    warnFg: "#FBBF24",
    errBg: "#351517",
    errFg: "#FECACA",
    link: "#FAFAFA",
  },
} as const;

/** Kvitbit's own header: the brand ink tile. */
export const kvitbitBrand: Brand = {
  name: "Kvitbit",
  initials: "K",
  accent: brandColors.iconTile,
  onAccent: brandColors.inkOnDark,
  invertInDark: true,
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Erode,Georgia,'Times New Roman',serif";
const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const TNUM = "font-variant-numeric:lining-nums tabular-nums;";
/** Long addresses, names and file names wrap inside the card instead of widening it. */
const WRAP = "overflow-wrap:anywhere;word-break:break-word;";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  " ": "&nbsp;",
};

/**
 * Escapes text for element content and double-quoted attributes. U+00A0 becomes `&nbsp;`.
 * Adapted from DeskoHub packages/email/backend/escaping.ts.
 */
export const escapeHtml = (value: string): string =>
  // @effect-diagnostics-next-line preferEffectString:off Effect's replace has no callback overload for a single-pass escape.
  value.replace(/[&<>"' ]/g, (c) => HTML_ESCAPES[c] ?? c);

const CRLF_OR_CR = /\r\n?/g;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** Multi-line user text (a custom message): escaped, line breaks become `<br>`. */
const escapeMultiline = (value: string): string =>
  Fn.pipe(value, Str.replace(CRLF_OR_CR, "\n"), escapeHtml, Str.replaceAll("\n", "<br>"));

/** Only absolute http(s) links reach the email; anything else becomes "#". */
const safeUrl = (url: string): string => (HTTP_URL.test(url) ? url : "#");

// HTML ---------------------------------------------------------------------------------------

/** Dark-mode hook classes for elements painted with the brand accent (brand ink only). */
const accentClass = (brand: Brand): string =>
  brand.invertInDark === true ? ' class="kb-accent"' : "";
const onAccentClass = (brand: Brand): string =>
  brand.invertInDark === true ? ' class="kb-on-accent"' : "";

const inlineHtml = (parts: ReadonlyArray<Inline>): string =>
  Fn.pipe(
    parts,
    Arr.map((p) => {
      if (Str.isString(p)) return escapeMultiline(p);
      if ("strong" in p) return `<strong>${escapeHtml(p.strong)}</strong>`;
      if ("mono" in p)
        return `<span style="font-family:${MONO};word-break:break-all;">${escapeHtml(p.mono)}</span>`;
      return "<br>";
    }),
    Arr.join(""),
  );

const summaryCell = (item: SummaryItem): string => {
  const family = item.mono === true ? `font-family:${MONO};` : "";
  const size = item.emphasis === true ? "font-size:15px;" : "";
  return (
    `<td class="kb-col" valign="top" width="50%" style="padding:3px 7px;width:50%;">` +
    `<div class="kb-muted" style="font-size:10.5px;color:${palette.muted};">${escapeHtml(item.label)}</div>` +
    `<div style="font-weight:600;${family}${size}">${escapeHtml(item.value)}</div></td>`
  );
};

const boxStyle =
  `background:${palette.sub};border:1px solid ${palette.border};border-radius:4px;` +
  "padding:12px 14px;font-size:12.5px;";

const blockHtml = (block: Block, brand: Brand): string => {
  switch (block._tag) {
    case "Pill": {
      const [bg, fg] =
        block.tone === "warn" ? [palette.warnBg, palette.warnFg] : [palette.errBg, palette.errFg];
      return (
        `<div style="margin:0 0 8px;"><span class="kb-${block.tone}" style="display:inline-block;background:${bg};color:${fg};` +
        `font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:3px;">${escapeHtml(block.text)}</span></div>`
      );
    }
    case "Heading":
      return `<h1 style="font-family:${SERIF};font-weight:600;font-size:19px;line-height:1.25;margin:0 0 10px;">${escapeHtml(block.text)}</h1>`;
    case "Paragraph":
      return `<p style="margin:0 0 12px;">${inlineHtml(block.parts)}</p>`;
    case "Muted":
      return `<p class="kb-muted" style="margin:0 0 12px;color:${palette.muted};font-size:11.5px;">${inlineHtml(block.parts)}</p>`;
    case "Summary": {
      const rows: Array<string> = [];
      for (let i = 0; i < block.items.length; i += 2) {
        const left = block.items[i];
        const right = block.items[i + 1];
        if (left === undefined) continue;
        rows.push(
          `<tr>${summaryCell(left)}${right === undefined ? '<td class="kb-col" width="50%" style="width:50%;"></td>' : summaryCell(right)}</tr>`,
        );
      }
      return (
        `<table role="presentation" class="kb-sub" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="${boxStyle}margin:14px 0;padding:9px 7px;border-collapse:separate;"><tbody>${Arr.join(rows, "")}</tbody></table>`
      );
    }
    case "Note":
      return (
        `<div class="kb-sub" style="${boxStyle}margin:14px 0;">` +
        `<div class="kb-muted" style="font-size:10.5px;color:${palette.muted};">${escapeHtml(block.label)}</div>` +
        `<div style="margin-top:2px;">${escapeMultiline(block.text)}</div></div>`
      );
    case "Attachment":
      return (
        `<div style="margin:0 0 10px;"><span class="kb-sub" style="display:inline-block;padding:5px 10px;border-radius:4px;` +
        `background:${palette.sub};border:1px solid ${palette.border};font-size:11.5px;">PDF · ` +
        `<span style="font-family:${MONO};word-break:break-all;">${escapeHtml(block.filename)}</span> (${escapeHtml(block.size)})</span></div>`
      );
    case "Button":
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px;"><tbody><tr>` +
        `<td${accentClass(brand)} bgcolor="${brand.accent}" style="background:${brand.accent};border-radius:4px;">` +
        `<a${onAccentClass(brand)} href="${escapeHtml(safeUrl(block.url))}" target="_blank" style="display:inline-block;padding:10px 18px;` +
        `font-family:${SANS};font-size:13px;font-weight:600;line-height:1.2;color:${brand.onAccent};text-decoration:none;` +
        `border-radius:4px;">${escapeHtml(block.label)}</a></td></tr></tbody></table>`
      );
    case "Link":
      return (
        `<p class="kb-muted" style="margin:0 0 12px;font-size:11.5px;color:${palette.muted};">` +
        `<a class="kb-link" href="${escapeHtml(safeUrl(block.url))}" target="_blank" style="color:${palette.fg};text-decoration:underline;">${escapeHtml(block.label)}</a></p>`
      );
  }
};

/** Mobile padding and stacked summary columns; dark surfaces where the client honours it. */
const HEAD_STYLE =
  "@media only screen and (max-width:620px){" +
  ".kb-container{width:100%!important;}" +
  ".kb-stage{padding:10px 8px 14px!important;}" +
  ".kb-pad{padding:16px 15px!important;}" +
  ".kb-foot{padding:10px 15px!important;}" +
  ".kb-col{display:block!important;width:100%!important;}}" +
  "@media (prefers-color-scheme:dark){" +
  `.kb-canvas{background:${palette.dark.canvas}!important;}` +
  `.kb-card{background:${palette.dark.card}!important;border-color:${palette.dark.border}!important;color:${palette.dark.fg}!important;}` +
  `.kb-sub{background:${palette.dark.sub}!important;border-color:${palette.dark.border}!important;}` +
  `.kb-muted{color:${palette.dark.muted}!important;}` +
  `.kb-rule{border-color:${palette.dark.border}!important;}` +
  `.kb-link{color:${palette.dark.link}!important;}` +
  `.kb-warn{background:${palette.dark.warnBg}!important;color:${palette.dark.warnFg}!important;}` +
  `.kb-error{background:${palette.dark.errBg}!important;color:${palette.dark.errFg}!important;}` +
  `.kb-accent{background:${brandColors.inkOnDark}!important;}` +
  `.kb-on-accent{background:${brandColors.inkOnDark}!important;color:${brandColors.iconTile}!important;}}`;

export const renderHtml = (content: EmailContent): string => {
  const { brand } = content;
  const body = Arr.join(
    Arr.map(content.blocks, (block) => blockHtml(block, brand)),
    "",
  );
  const brandRow =
    `<table role="presentation" class="kb-rule" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="margin:0 0 16px;border-bottom:1px solid ${palette.border};"><tbody><tr>` +
    `<td width="24" style="padding:0 8px 12px 0;width:24px;">` +
    `<div${onAccentClass(brand)} style="width:24px;height:24px;line-height:24px;border-radius:4px;background:${brand.accent};` +
    `color:${brand.onAccent};text-align:center;font-family:${SERIF};font-weight:600;font-size:12px;">${escapeHtml(brand.initials)}</div></td>` +
    `<td style="padding:0 0 12px;font-size:13.5px;font-weight:700;">${escapeHtml(brand.name)}</td></tr></tbody></table>`;
  return (
    "<!DOCTYPE html>" +
    `<html lang="${content.locale}" xmlns="http://www.w3.org/1999/xhtml"><head>` +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="x-apple-disable-message-reformatting">' +
    '<meta name="color-scheme" content="light dark">' +
    '<meta name="supported-color-schemes" content="light dark">' +
    `<title>${escapeHtml(content.subject)}</title>` +
    `<style>${HEAD_STYLE}</style></head>` +
    `<body class="kb-canvas" style="margin:0;padding:0;background:${palette.canvas};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</div>` +
    `<table role="presentation" class="kb-canvas" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${palette.canvas};"><tbody><tr>` +
    `<td class="kb-stage" align="center" style="padding:24px 12px;">` +
    `<table role="presentation" class="kb-container kb-card" width="600" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:600px;background:${palette.card};border:1px solid ${palette.border};border-radius:5px;` +
    `border-collapse:separate;overflow:hidden;color:${palette.fg};font-family:${SANS};${TNUM}${WRAP}"><tbody>` +
    `<tr><td${accentClass(brand)} height="4" style="height:4px;line-height:4px;font-size:0;background:${brand.accent};">&nbsp;</td></tr>` +
    `<tr><td class="kb-pad" style="padding:22px 24px 20px;font-size:13px;line-height:1.55;text-align:left;${WRAP}">${brandRow}${body}</td></tr>` +
    `<tr><td class="kb-foot kb-sub kb-muted kb-rule" style="padding:12px 24px;background:${palette.sub};border-top:1px solid ${palette.border};` +
    `font-size:11px;line-height:1.45;color:${palette.muted};text-align:left;${WRAP}">${escapeHtml(Arr.join(content.footer, " · "))}</td></tr>` +
    "</tbody></table></td></tr></tbody></table></body></html>"
  );
};

// Plain text ---------------------------------------------------------------------------------

const inlineText = (parts: ReadonlyArray<Inline>): string =>
  Fn.pipe(
    parts,
    Arr.map((p) => {
      if (Str.isString(p)) return p;
      if ("strong" in p) return p.strong;
      if ("mono" in p) return p.mono;
      return "\n";
    }),
    Arr.join(""),
  );

const blockText = (block: Block): string => {
  switch (block._tag) {
    case "Pill":
      return `[${block.text}]`;
    case "Heading":
      return block.text;
    case "Paragraph":
    case "Muted":
      return inlineText(block.parts);
    case "Summary":
      return Arr.join(
        Arr.map(block.items, (i) => `${i.label}: ${i.value}`),
        "\n",
      );
    case "Note":
      return `${block.label}:\n${block.text}`;
    case "Attachment":
      return `PDF: ${block.filename} (${block.size})`;
    case "Button":
    case "Link":
      return `${block.label}:\n${safeUrl(block.url)}`;
  }
};

export const renderText = (content: EmailContent): string =>
  Fn.pipe(
    [
      content.brand.name,
      ...Arr.map(content.blocks, blockText),
      "--",
      Arr.join(content.footer, " · "),
    ],
    Arr.join("\n\n"),
    Str.replace(CRLF_OR_CR, "\n"),
  );
