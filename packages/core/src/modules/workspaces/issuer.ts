/**
 * `IssuerSnapshots`: the issuer half of a document snapshot in the shape agreed with
 * core-documents (board #407, #414), derived from `WorkspaceSnapshots`. No policy check; runs
 * inside the caller's transaction. The requested Workspace must be the current caller's own
 * (Member or System caller, rule R2): any other Workspace, a missing one, or any other caller kind
 * is `NotFound{Workspace}`, so a mis-scoped document operation never reads another issuer.
 */
import type {
  BankAccountId,
  CurrencyCode,
  IsoDate,
  NotFound,
  TaxRegime,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, NotFound as NotFoundError } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { WorkspaceBillingDefaults, WorkspaceReminderPolicy } from "../../shared/overrides";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { PaymentRounding } from "./model";
import { WorkspaceSnapshots } from "./snapshots";

export interface IssuerBankAccount {
  readonly id: BankAccountId;
  readonly name: string | null;
  readonly currency: CurrencyCode;
  /** Czech domestic form `prefix-number/bank` (prefix omitted when zero); null for a non-CZ IBAN. */
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
    readonly address: {
      readonly street: string | null;
      readonly city: string | null;
      readonly postalCode: string | null;
      readonly country: string;
    };
    /** §435 commercial register line, verbatim. */
    readonly registerEntry: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly web: string | null;
  };
  /** The Tax Regime in force on `on` (the tax point). */
  readonly regime: TaxRegime;
  readonly bankAccounts: ReadonlyArray<IssuerBankAccount>;
  readonly billing: WorkspaceBillingDefaults;
  readonly reminders: WorkspaceReminderPolicy;
  readonly paymentRounding: PaymentRounding;
  readonly revision: number;
}

/** `CZkk BBBB PPPPPP NNNNNNNNNN` -> `PPPPPP-NNNNNNNNNN/BBBB` without leading zeros; else null. */
export const czechAccountNumber = (iban: string): string | null => {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  const match = /^CZ\d{2}(\d{4})(\d{6})(\d{10})$/.exec(compact);
  if (match === null) return null;
  const [, bank, prefix, number] = match as unknown as [string, string, string, string];
  const strip = (digits: string) => digits.replace(/^0+(?=\d)/, "");
  const head = /^0+$/.test(prefix) ? "" : `${strip(prefix)}-`;
  return `${head}${strip(number)}/${bank}`;
};

export class IssuerSnapshots extends Context.Service<
  IssuerSnapshots,
  {
    readonly forDocument: (
      workspaceId: WorkspaceId,
      on: IsoDate,
    ) => Effect.Effect<IssuerForDocument, NotFound | StoreUnavailable, CurrentCaller>;
  }
>()("kvitbit/core/IssuerSnapshots") {}

/** Fails `NotFound{Workspace}` unless `workspaceId` is the current Member or System caller's. */
const ownWorkspace = (workspaceId: WorkspaceId): Effect.Effect<void, NotFound, CurrentCaller> =>
  Effect.flatMap(Effect.service(CurrentCaller), (caller) =>
    (caller._tag === "Member" || caller._tag === "System") && caller.workspaceId === workspaceId
      ? Effect.void
      : Effect.fail(new NotFoundError({ entity: "Workspace", id: workspaceId })),
  );

export const IssuerSnapshotsLive: Layer.Layer<IssuerSnapshots, never, WorkspaceSnapshots> =
  Layer.effect(
    IssuerSnapshots,
    Effect.map(Effect.service(WorkspaceSnapshots), (snapshots) => ({
      forDocument: (workspaceId, on) =>
        Effect.andThen(ownWorkspace(workspaceId), snapshots.get(workspaceId, on)).pipe(
          Effect.map((s) => ({
            party: {
              workspaceId: s.workspaceId,
              name: s.issuingEntity.name,
              ico: s.issuingEntity.ico,
              dic: s.issuingEntity.dic,
              address: { ...s.issuingEntity.address },
              registerEntry: s.issuingEntity.registerEntry,
              email: s.issuingEntity.email,
              phone: s.issuingEntity.phone,
              web: s.issuingEntity.web,
            },
            regime: s.taxRegime,
            bankAccounts: s.bankAccounts.map((a) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
              accountNumber: czechAccountNumber(a.iban),
              iban: a.iban,
              bic: a.bic,
              isDefault: a.isDefault,
            })),
            billing: s.billing,
            reminders: s.reminders,
            paymentRounding: s.paymentRounding,
            revision: s.revision,
          })),
        ),
    })),
  );
