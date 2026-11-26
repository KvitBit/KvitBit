/**
 * Localized MCP tool error formatting (http-mcp-contracts section 6.8).
 * Core errors inside a tool become a tool result with `isError: true`,
 * `structuredContent: { error: <encoded tagged CoreError> }`, and localized text.
 */
import { McpToolError } from "@kvitbit/api-contract";
import { can } from "@kvitbit/core";
import type { Action, CoreError, Locale, MemberCaller } from "@kvitbit/domain/contract";
import { Schema } from "effect";

export const encodeToolError = Schema.encodeUnknownSync(Schema.toCodecJson(McpToolError));

const ACTION_LABELS_EN: Partial<Record<Action, string>> = {
  "workspace.read": "read Workspace details",
  "document.read": "read documents",
  "document.history": "read document history",
  "document.pdf": "download document PDFs",
  "document.draft": "create drafts",
  "document.edit": "edit documents",
  "document.issue": "issue documents",
  "document.send": "send documents",
  "document.lock": "lock documents",
  "document.finalInvoice": "create final invoices",
  "document.correct": "create credit notes",
  "payment.read": "read payments",
  "payment.write": "record payments",
  "expense.read": "read expenses",
  "expense.write": "record expenses",
  "expense.attachment.read": "read expense attachments",
  "contact.read": "read contacts",
  "contact.write": "save contacts",
  "priceList.read": "read price list items",
  "template.read": "read invoice templates",
  "share.read": "read share links",
  "report.run": "run reports",
};

const ACTION_LABELS_CS: Partial<Record<Action, string>> = {
  "workspace.read": "číst údaje pracovního prostoru",
  "document.read": "číst doklady",
  "document.history": "číst historii dokladu",
  "document.pdf": "stahovat PDF dokladů",
  "document.draft": "vytvářet koncepty",
  "document.edit": "upravovat doklady",
  "document.issue": "vystavovat doklady",
  "document.send": "odesílat doklady",
  "document.lock": "uzamykat doklady",
  "document.finalInvoice": "vystavovat konečné faktury",
  "document.correct": "vystavovat opravné daňové doklady",
  "payment.read": "číst platby",
  "payment.write": "evidovat platby",
  "expense.read": "číst náklady",
  "expense.write": "evidovat náklady",
  "expense.attachment.read": "číst přílohy nákladů",
  "contact.read": "číst kontakty",
  "contact.write": "ukládat kontakty",
  "priceList.read": "číst ceník",
  "template.read": "číst šablony faktur",
  "share.read": "číst sdílené odkazy",
  "report.run": "spouštět přehledy",
};

const actionLabel = (action: Action, locale: Locale): string =>
  (locale === "cs" ? ACTION_LABELS_CS[action] : ACTION_LABELS_EN[action]) ?? action;

const hasAnyWriteScope = (caller: MemberCaller): boolean => {
  if (caller.scopes === "all") return true;
  return caller.scopes.some((scope) => scope.endsWith(":write"));
};

/**
 * Formats a `Forbidden{action}` message per section 6.8:
 * - Role allows the action, grant does not -> explains read-only / reconnect with write access.
 * - Role does not allow the action -> names the role in this Workspace.
 */
export const formatForbiddenText = (action: Action, caller: MemberCaller): string => {
  const roleAllows = can({ ...caller, scopes: "all" }, action);
  const label = actionLabel(action, caller.locale);
  if (roleAllows) {
    if (!hasAnyWriteScope(caller)) {
      return caller.locale === "cs"
        ? `Toto připojení je pouze pro čtení. Znovu připojte Kvitbit s přístupem pro čtení i zápis, abyste mohli ${label}.`
        : `This connection is read only. Reconnect Kvitbit with read and write access to ${label}.`;
    }
    return caller.locale === "cs"
      ? `Toto připojení nemá oprávnění ${label}. Znovu připojte Kvitbit s potřebným přístupem.`
      : `This connection does not have access to ${label}. Reconnect Kvitbit with the required scopes.`;
  }
  return caller.locale === "cs"
    ? `Vaše role v tomto pracovním prostoru (${caller.role}) nemůže ${label}.`
    : `Your role in this Workspace (${caller.role}) cannot ${label}.`;
};

export const formatCoreErrorText = (error: CoreError, caller: MemberCaller): string => {
  const cs = caller.locale === "cs";
  switch (error._tag) {
    case "Forbidden":
      return formatForbiddenText(error.action, caller);
    case "NotFound":
      return cs
        ? `Záznam ${error.entity} (${error.id}) nebyl nalezen.`
        : `${error.entity} (${error.id}) was not found.`;
    case "Invalid": {
      const details = error.issues
        .map((issue) =>
          issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.code}` : issue.code,
        )
        .join("; ");
      return cs ? `Neplatný požadavek: ${details}.` : `Invalid request: ${details}.`;
    }
    case "Conflict": {
      switch (error.reason) {
        case "revision_changed":
          return cs
            ? `Záznam byl mezitím změněn (aktuální revize ${error.currentRevision ?? "neznámá"}). Načtěte jej znovu.`
            : `The record changed since you last read it (current revision ${error.currentRevision ?? "unknown"}). Read it again before retrying.`;
        case "document_locked":
          return cs
            ? "Doklad je uzamčen a nelze jej upravit."
            : "The document is locked and cannot be modified.";
        case "illegal_transition":
          return cs
            ? `Operaci nelze v aktuálním stavu dokladu provést${error.detail ? ` (${error.detail})` : ""}.`
            : `Operation is not allowed in the current state${error.detail ? ` (${error.detail})` : ""}.`;
        case "duplicate":
          return cs
            ? `Duplicitní záznam${error.detail ? ` (${error.detail})` : ""}.`
            : `Duplicate record${error.detail ? ` (${error.detail})` : ""}.`;
        case "idempotency_mismatch":
          return cs
            ? "Stejný klíč idempotence byl již použit s jinými parametry."
            : "The same idempotency key was already used with different arguments.";
        default:
          return cs ? "Konflikt." : "Conflict.";
      }
    }
    case "Unavailable":
      return cs
        ? `Služba ${error.dependency} je dočasně nedostupná. Zkuste to prosím později.`
        : `Service ${error.dependency} is temporarily unavailable. Please try again later.`;
  }
};

export interface McpToolCallResult {
  readonly isError: boolean;
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "resource_link";
        readonly uri: string;
        readonly name: string;
        readonly mimeType: string;
      }
    | {
        readonly type: "resource";
        readonly resource: {
          readonly uri: string;
          readonly mimeType: string;
          readonly blob: string;
        };
      }
  >;
  readonly structuredContent?: Record<string, unknown>;
}

export const coreErrorToolResult = (error: CoreError, caller: MemberCaller): McpToolCallResult => ({
  isError: true,
  content: [{ type: "text", text: formatCoreErrorText(error, caller) }],
  structuredContent: encodeToolError({ error }) as Record<string, unknown>,
});
