/**
 * Transactional email templates E01-E08 (`@kvitbit/adapters/templates/email`).
 *
 * `renderEmail(template, locale)` is pure and synchronous. Its `subject`, `html` and `text` map
 * onto the same fields of the domain `OutboundEmail`; callers add recipients, Reply-To,
 * attachments and tags. All input strings are plain text and are escaped for HTML here.
 */
import type { Locale } from "@kvitbit/domain/contract";
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

export const renderEmail = (template: EmailTemplate, locale: Locale): RenderedEmail => {
  const built = emailContent(template, locale);
  // A subject is one header line: line breaks from interpolated names or overrides collapse.
  const content = { ...built, subject: built.subject.replace(/\s*[\r\n]+\s*/g, " ").trim() };
  return { subject: content.subject, html: renderHtml(content), text: renderText(content) };
};

/** Alias of `renderEmail`. */
export const render = renderEmail;
