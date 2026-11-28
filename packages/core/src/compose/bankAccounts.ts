/**
 * `BankAccountReferencesLive`: the Workspaces `BankAccountReferences` port (core-ports 4.1,
 * `removeBankAccount` and a currency change in `saveBankAccount`) over the documents and
 * recurring repos.
 *
 * A draft uses an account when it chose it (`given.bankAccount`) or when the account was
 * resolved into its issuer snapshot (the currency default); issued and cancelled documents keep
 * their snapshot (rule D10) and are never counted or changed. A Template uses an account when
 * its saved input names it; archived Templates cannot be used again and are left out.
 *
 * Both methods run inside the caller's CoreStore transaction (Workspaces locks the Workspace
 * row first), never authorize and never audit: Workspaces audits the removal.
 *
 * Requires DocumentsRepo | RecurringRepo | WorkspacesRepo.
 */
import type { BankAccountId, WorkspaceId } from "@kvitbit/domain/contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DocumentRecord } from "../modules/documents";
import { DocumentsRepo } from "../modules/documents";
import { RecurringRepo } from "../modules/recurring";
import { BankAccountReferences, czechAccountNumber, WorkspacesRepo } from "../modules/workspaces";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The candidates are read unlocked, so a row can be deleted (`discardDraft`) or changed between
 * that read and its lock: `relock` turns a missing row into `null` and the caller re-checks the
 * locked row. Once a row is locked, a stale revision, a missing row or a unique clash is a bug.
 */
const relock = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is E & { readonly _tag: "NotFound" } => error._tag === "NotFound",
    () => Effect.succeed(null),
  );

const locked = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is E & { readonly _tag: "NotFound" | "Conflict" | "UniqueViolation" } =>
      error._tag === "NotFound" || error._tag === "Conflict" || error._tag === "UniqueViolation",
    (error) => Effect.die(error),
  );

export const BankAccountReferencesLive: Layer.Layer<
  BankAccountReferences,
  never,
  DocumentsRepo | RecurringRepo | WorkspacesRepo
> = Layer.effect(
  BankAccountReferences,
  Effect.gen(function* () {
    const documents = yield* DocumentsRepo;
    const recurring = yield* RecurringRepo;
    const workspaces = yield* WorkspacesRepo;

    const uses = (workspaceId: WorkspaceId, id: BankAccountId) =>
      Effect.all(
        [
          documents.draftsUsingBankAccount(workspaceId, id),
          recurring.templatesUsingBankAccount(workspaceId, id),
        ],
        { concurrency: 1 },
      );

    /** The draft with `to` in place of `from`, the issuer snapshot taken from `to` as of now. */
    const moved = (
      row: DocumentRecord,
      from: BankAccountId,
      snapshot: NonNullable<DocumentRecord["issuer"]["bankAccount"]>,
      at: string,
    ): DocumentRecord => ({
      ...row,
      given:
        row.given.bankAccount === from ? { ...row.given, bankAccount: snapshot.id } : row.given,
      issuer:
        row.issuer.bankAccount?.id === from ? { ...row.issuer, bankAccount: snapshot } : row.issuer,
      updatedAt: at,
    });

    return BankAccountReferences.of({
      count: Effect.fn("BankAccountReferences.count")((workspaceId, id) =>
        Effect.map(
          uses(workspaceId, id),
          ([drafts, templates]) => drafts.length + templates.length,
        ),
      ),

      reassign: Effect.fn("BankAccountReferences.reassign")(function* (workspaceId, from, to) {
        if (from === to) return;
        const [drafts, templates] = yield* uses(workspaceId, from);
        if (drafts.length === 0 && templates.length === 0) return;
        const at = yield* nowIso;
        // Workspaces validated the replacement (active, same currency, same Workspace).
        const account = yield* locked(workspaces.getBankAccount(workspaceId, to));
        const snapshot = {
          id: account.id,
          name: account.name,
          currency: account.currency,
          accountNumber: czechAccountNumber(account.iban),
          iban: account.iban,
          bic: account.bic,
        };
        for (const draft of drafts) {
          const row = yield* relock(documents.lock(workspaceId, draft.id));
          // Discarded, issued or moved off the account between the read and the lock: an
          // issued document keeps its snapshot (D10), the others have nothing to move.
          if (row === null || row.status !== "draft") continue;
          if (row.given.bankAccount !== from && row.issuer.bankAccount?.id !== from) continue;
          yield* locked(documents.update(moved(row, from, snapshot, at), row.revision));
        }
        for (const template of templates) {
          const row = yield* relock(recurring.lockTemplateState(workspaceId, template.id));
          // Gone, archived or moved off the account between the read and the lock.
          if (row === null || row.archivedAt !== null || row.input.bankAccount !== from) continue;
          yield* locked(
            recurring.updateTemplate(
              { ...row, input: { ...row.input, bankAccount: to }, updatedAt: at },
              row.revision,
            ),
          );
        }
      }),
    });
  }),
);
