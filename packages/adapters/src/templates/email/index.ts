/**
 * Transactional email templates E01-E08 (`@kvitbit/adapters/templates/email`).
 *
 * `renderEmail(template, locale)` is pure and synchronous. Its `subject`, `html` and `text` map
 * onto the same fields of the domain `OutboundEmail`; callers add recipients, Reply-To,
 * attachments and tags. All input strings are plain text and are escaped for HTML here.
 */
import type { Locale } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { renderHtml, renderText } from "./layout";
import { type EmailTemplate, emailContent } from "./templates";

export { formatDate, formatDuration, formatFileSize, formatMoney, NBSP } from "./format";
export { escapeHtml } from "./layout";
export type {
  E01AlreadyRegistered,
  E01Verify,
  E02MagicLink,
  E03PasswordReset,
  E04Invitation,
  E05DocumentDelivery,
  E06OverdueReminder,
  E07ConfirmNew,
  E07NoticeOld,
  E08NeedsAttention,
  EmailAccent,
  EmailIssuerFooter,
  EmailTemplate,
  EmailTemplateId,
  EmailWorkspace,
} from "./templates";

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export const renderEmail: {
  (locale: Locale): (template: EmailTemplate) => RenderedEmail;
  (template: EmailTemplate, locale: Locale): RenderedEmail;
} = Fn.dual(2, (template: EmailTemplate, locale: Locale): RenderedEmail => {
  const built = emailContent(locale)(template);
  // A subject is one header line: line breaks from interpolated names or overrides collapse.
  const subject = Fn.pipe(built.subject, Str.replace(/\s*[\r\n]+\s*/g, " "), Str.trim);
  const content = { ...built, subject };
  return { subject: content.subject, html: renderHtml(content), text: renderText(content) };
});
