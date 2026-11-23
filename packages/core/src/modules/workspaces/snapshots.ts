/**
 * `WorkspaceSnapshots`: the narrow read port other modules (documents, templates, share links)
 * use to snapshot the issuing Workspace onto a document: Issuing Entity, the Tax Regime in force
 * at the tax point (W2), billing defaults for the override chain, reminder schedule, bank
 * accounts and branding. Core-internal; it takes a `workspaceId` the calling module already
 * scoped from its own caller, and performs no policy check.
 */
import type {
  BankAccountId,
  DocumentKind,
  IsoDate,
  NumberingSeriesId,
  TaxRegime,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { WorkspaceBillingDefaults, WorkspaceReminderPolicy } from "../../shared/overrides";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { BankAccountViewFields, Branding, IssuingEntity, PaymentRounding } from "./model";
import { WorkspaceSeries } from "./ports";
import { WorkspacesRepo } from "./repo";
import { regimeOn } from "./rules";

export interface WorkspaceSnapshot {
  readonly workspaceId: WorkspaceId;
  /** Part of every cached PDF key (W7). */
  readonly revision: number;
  readonly slug: WorkspaceSlug;
  readonly name: string;
  /** W5: a closed Workspace rejects every non-read action. */
  readonly closed: boolean;
  readonly issuingEntity: IssuingEntity;
  /** The regime in force on `asOf`. */
  readonly taxRegime: TaxRegime;
  /** The Workspace level of `resolveDocumentDefaults` (seriesByKind = default series per kind). */
  readonly billing: WorkspaceBillingDefaults;
  readonly paymentRounding: PaymentRounding;
  readonly paymentTaxDocumentAutoSend: boolean;
  /** The Workspace level of `resolveReminders`. */
  readonly reminders: WorkspaceReminderPolicy;
  /** Active accounts; `isDefault` marks the default per currency. */
  readonly bankAccounts: ReadonlyArray<BankAccountViewFields>;
  readonly branding: Branding;
}

export class WorkspaceSnapshots extends Context.Service<
  WorkspaceSnapshots,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      asOf: IsoDate,
    ) => Effect.Effect<WorkspaceSnapshot, NotFound | StoreUnavailable>;
    /** One active bank account; archived or another Workspace's is NotFound{BankAccount}. */
    readonly bankAccount: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
    ) => Effect.Effect<BankAccountViewFields, NotFound | StoreUnavailable>;
  }
>()("kvitbit/core/WorkspaceSnapshots") {}

export const WorkspaceSnapshotsLive: Layer.Layer<
  WorkspaceSnapshots,
  never,
  WorkspacesRepo | WorkspaceSeries
> = Layer.effect(
  WorkspaceSnapshots,
  Effect.gen(function* () {
    const repo = yield* WorkspacesRepo;
    const series = yield* WorkspaceSeries;
    const view = (
      account: { readonly id: BankAccountId; readonly currency: string },
      byCurrency: Readonly<Record<string, BankAccountId>>,
    ) => byCurrency[account.currency] === account.id;
    return {
      get: (workspaceId, asOf) =>
        Effect.gen(function* () {
          const row = yield* repo.getWorkspace(workspaceId);
          const accounts = (yield* repo.listBankAccounts(workspaceId)).filter((a) => !a.archived);
          const seriesByKind: { [K in DocumentKind]?: NumberingSeriesId } = {};
          for (const s of yield* series.list(workspaceId, asOf)) {
            if (s.isDefault) seriesByKind[s.kind] = s.id;
          }
          return {
            workspaceId,
            revision: row.revision,
            slug: row.slug,
            name: row.name,
            closed: row.closed,
            issuingEntity: row.issuingEntity,
            taxRegime: regimeOn(row.taxRegimes, asOf),
            billing: {
              currency: row.defaults.currency,
              language: row.defaults.language,
              dueDays: row.defaults.dueDays,
              paymentMethod: row.defaults.paymentMethod,
              seriesByKind,
              defaultNote: row.defaults.defaultNote,
            },
            paymentRounding: row.defaults.paymentRounding,
            paymentTaxDocumentAutoSend: row.defaults.paymentTaxDocumentAutoSend,
            reminders: row.reminders,
            bankAccounts: accounts.map((a) => ({
              id: a.id,
              name: a.name,
              iban: a.iban,
              bic: a.bic,
              currency: a.currency,
              isDefault: view(a, row.bankAccountByCurrency),
              revision: a.revision,
            })),
            branding: row.branding,
          };
        }),
      bankAccount: (workspaceId, id) =>
        Effect.gen(function* () {
          const account = yield* repo.getBankAccount(workspaceId, id);
          const row = yield* repo.getWorkspace(workspaceId);
          if (account.archived) {
            return yield* new NotFound({ entity: "BankAccount", id });
          }
          return {
            id: account.id,
            name: account.name,
            iban: account.iban,
            bic: account.bic,
            currency: account.currency,
            isDefault: view(account, row.bankAccountByCurrency),
            revision: account.revision,
          };
        }),
    };
  }),
);
