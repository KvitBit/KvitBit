/**
 * The Document → Contact → Workspace override chain (core-ports 4.2) and the effective reminder
 * policy (rule D16). Pure: modules load the three levels and call these.
 */

import type {
  ContactDefaults,
  CurrencyCode,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  ReminderPolicy,
} from "@kvitbit/domain/contract";
import { DocumentKind, resolveDefault } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";

/** A per-kind series map; a kind left out has no series at that level. */
export type SeriesByKind = { readonly [K in DocumentKind]?: NumberingSeriesId };

/** The Workspace level of the chain: always complete except where a value may be absent. */
export interface WorkspaceBillingDefaults {
  readonly currency: CurrencyCode;
  readonly language: Locale;
  readonly dueDays: number;
  readonly paymentMethod: PaymentMethod;
  /** Default Numbering Series per kind. */
  readonly seriesByKind: SeriesByKind;
  readonly defaultNote: string | null;
}

/** Values set on the Document itself (input fields); `undefined` = not set. */
export interface DocumentOverrides {
  readonly currency?: CurrencyCode | undefined;
  readonly language?: Locale | undefined;
  readonly dueDays?: number | undefined;
  readonly paymentMethod?: PaymentMethod | undefined;
  readonly series?: NumberingSeriesId | undefined;
  readonly note?: string | undefined;
}

export interface ResolvedDocumentDefaults {
  readonly currency: CurrencyCode;
  readonly language: Locale;
  readonly dueDays: number;
  readonly paymentMethod: PaymentMethod;
  /** null when no level names a series for this kind. */
  readonly series: NumberingSeriesId | null;
  readonly note: string | null;
}

/** Contact `preferredSeriesByKind` merged over the Workspace map, kind by kind. */
export const mergeSeriesByKind: {
  (workspace: SeriesByKind): (contact: SeriesByKind | undefined) => SeriesByKind;
  (contact: SeriesByKind | undefined, workspace: SeriesByKind): SeriesByKind;
} = Fn.dual(2, (contact: SeriesByKind | undefined, workspace: SeriesByKind) => {
  const merged = { ...workspace };
  for (const kind of DocumentKind.literals) {
    const series = contact?.[kind];
    if (series !== undefined) merged[kind] = series;
  }
  return merged;
});

export const resolveDocumentDefaults = (input: {
  readonly kind: DocumentKind;
  readonly document?: DocumentOverrides | undefined;
  readonly contact?: ContactDefaults | undefined;
  readonly workspace: WorkspaceBillingDefaults;
}): ResolvedDocumentDefaults => {
  const document = input.document ?? {};
  const contact = input.contact ?? {};
  const { workspace } = input;
  return {
    currency: resolveDefault(document.currency, contact.currency, workspace.currency),
    language: resolveDefault(document.language, contact.language, workspace.language),
    dueDays: resolveDefault(document.dueDays, contact.dueDays, workspace.dueDays),
    paymentMethod: resolveDefault(
      document.paymentMethod,
      contact.paymentMethod,
      workspace.paymentMethod,
    ),
    series: resolveDefault<NumberingSeriesId | null>(
      document.series,
      contact.preferredSeriesByKind?.[input.kind],
      workspace.seriesByKind[input.kind] ?? null,
    ),
    note: resolveDefault<string | null>(document.note, contact.defaultNote, workspace.defaultNote),
  };
};

// Reminders (rule D16) ----------------------------------------------------------------------

/** What a `send` stored as `documents.reminders_choice`. */
export type RemindersChoice = "on" | "off" | "inherit";

/** The Workspace reminder schedule. */
export interface WorkspaceReminderPolicy {
  readonly enabled: boolean;
  /** Whether Proformas get reminders (the Workspace's Proforma setting). */
  readonly proformas: boolean;
  /** Days after the due date. */
  readonly offsetsDays: ReadonlyArray<number>;
}

export interface EffectiveReminders {
  readonly arms: boolean;
  /** Offsets the `PaymentReminders` payload carries; empty when nothing is armed. */
  readonly offsetsDays: ReadonlyArray<number>;
}

const NONE: EffectiveReminders = { arms: false, offsetsDays: [] };
const armed = (offsetsDays: ReadonlyArray<number>): EffectiveReminders =>
  offsetsDays.length === 0 ? NONE : { arms: true, offsetsDays };

/**
 * Rule D16. Only Invoices and Proformas are reminded. `off` arms nothing; a Contact on
 * `disabled` arms nothing unless the choice is `on`; `custom` uses its own offsets; `inherit`
 * (or no Contact policy) follows the Workspace (enabled flag and Proforma setting); an explicit
 * `on` with `disabled` or `inherit` uses the Workspace offsets regardless of those flags.
 */
export const resolveReminders = (input: {
  readonly kind: DocumentKind;
  readonly choice: RemindersChoice;
  readonly contact?: ReminderPolicy | undefined;
  readonly workspace: WorkspaceReminderPolicy;
}): EffectiveReminders => {
  const { kind, choice, workspace } = input;
  if (kind !== "invoice" && kind !== "proforma") return NONE;
  if (choice === "off") return NONE;
  const { contact } = input;
  if (contact?.mode === "custom") return armed(contact.offsetsDays);
  if (contact?.mode === "disabled") return choice === "on" ? armed(workspace.offsetsDays) : NONE;
  return choice === "on" || (workspace.enabled && (kind === "invoice" || workspace.proformas))
    ? armed(workspace.offsetsDays)
    : NONE;
};
