/**
 * Narrow read ports Documents needs from other modules, and the renderer port. None of them
 * authorizes: the calling Documents method has already authorized its own action in the same
 * Workspace. All run inside the caller's CoreStore transaction; another Workspace's record is
 * `NotFound` (rule R2).
 *
 * `DocumentContacts` and `DocumentPriceList` are structurally identical to core-identity's
 * `ContactSnapshots.forDocument` and `PriceListItems.forLine` (board agreement #402); the
 * Issuing Entity shape is #407 as accepted in #414 and amended in #418 (it reads
 * `CurrentCaller`: a workspaceId other than the caller's is NotFound{Workspace}). Integration binds each with a one-line layer, e.g.
 * `Layer.effect(DocumentContacts, Effect.map(ContactSnapshots, (s) => DocumentContacts.of(s)))`.
 */
import type {
  BankAccountId,
  ContactDefaults,
  ContactId,
  ContactRole,
  CurrencyCode,
  CurrentCaller,
  DocumentView,
  IsoDate,
  Locale,
  NotFound,
  PdfTemplate,
  PriceListItemId,
  TaxRegime,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { WorkspaceBillingDefaults, WorkspaceReminderPolicy } from "../../shared/overrides";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { AddressRecord } from "./record";

// Contacts (core-identity #402 (1)) ---------------------------------------------------------

export interface ContactForDocument {
  readonly party: {
    readonly contactId: ContactId;
    readonly name: string;
    readonly ico: string | null;
    /** DIČ (VAT ID) as stored. */
    readonly dic: string | null;
    readonly legalForm: string | null;
    readonly address: AddressRecord;
  };
  /** The Contact level of the override chain (`reminderPolicy` always set). */
  readonly defaults: ContactDefaults;
  readonly roles: ReadonlyArray<ContactRole>;
  readonly billingEmails: ReadonlyArray<string>;
  readonly archived: boolean;
  readonly revision: number;
}

export class DocumentContacts extends Context.Service<
  DocumentContacts,
  {
    readonly forDocument: (
      workspaceId: WorkspaceId,
      id: ContactId,
    ) => Effect.Effect<ContactForDocument, NotFound | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/documents/ports/DocumentContacts") {}

// Price List (core-identity #402 (2)) -------------------------------------------------------

export interface PriceListItemForLine {
  readonly id: PriceListItemId;
  readonly name: string;
  readonly description: string | null;
  readonly unit: string | null;
  /** Excl. VAT, in `currency`. */
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly currency: CurrencyCode;
  /** null leaves the treatment to the Tax Regime and Contact (rule D9). */
  readonly vat: VatTreatment | null;
  readonly archived: boolean;
  readonly revision: number;
}

export class DocumentPriceList extends Context.Service<
  DocumentPriceList,
  {
    readonly forLine: (
      workspaceId: WorkspaceId,
      id: PriceListItemId,
    ) => Effect.Effect<PriceListItemForLine, NotFound | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/documents/ports/DocumentPriceList") {}

// Issuing Entity (proposal #407 to core-identity / ci-workspaces) ---------------------------

export interface IssuerBankAccount {
  readonly id: BankAccountId;
  readonly name: string | null;
  readonly currency: CurrencyCode;
  /** Czech domestic form, e.g. `123456789/0100`. */
  readonly accountNumber: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
  /** The default account for its currency. */
  readonly isDefault: boolean;
}

export interface IssuerForDocument {
  readonly party: {
    readonly workspaceId: WorkspaceId;
    readonly name: string;
    readonly ico: string | null;
    readonly dic: string | null;
    readonly address: AddressRecord;
    readonly registerEntry: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly web: string | null;
  };
  /** Tax Regime in force on the date asked for (the tax point). */
  readonly regime: TaxRegime;
  readonly bankAccounts: ReadonlyArray<IssuerBankAccount>;
  readonly billing: WorkspaceBillingDefaults;
  readonly reminders: WorkspaceReminderPolicy;
  readonly paymentRounding: "none" | "whole_unit";
  readonly revision: number;
}

export class DocumentIssuers extends Context.Service<
  DocumentIssuers,
  {
    readonly forDocument: (
      workspaceId: WorkspaceId,
      on: IsoDate,
    ) => Effect.Effect<IssuerForDocument, NotFound | StoreUnavailable, CurrentCaller>;
  }
>()("@kvitbit/core/modules/documents/ports/DocumentIssuers") {}

// Renderer ----------------------------------------------------------------------------------

export interface RenderOptions {
  readonly template: PdfTemplate;
  readonly language: Locale;
}

/**
 * Document view -> PDF bytes. Pure rendering (adapters implement it in-process, no I/O), so
 * it cannot fail except by defect. Caching (key includes `revision`, rule D3) is the caller's.
 */
export class DocumentRenderer extends Context.Service<
  DocumentRenderer,
  {
    readonly render: (view: DocumentView, options: RenderOptions) => Effect.Effect<Uint8Array>;
  }
>()("@kvitbit/core/modules/documents/ports/DocumentRenderer") {}
