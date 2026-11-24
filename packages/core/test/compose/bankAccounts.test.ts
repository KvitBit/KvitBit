/** BankAccountReferencesLive over the real documents layers and the memory repos. */
import { describe, expect, test } from "bun:test";
import type { BankAccountId, DocumentId, TemplateId } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import { Effect, Exit, Layer } from "effect";
import { BankAccountReferencesLive } from "../../src/compose/bankAccounts";
import { DocumentsRepo } from "../../src/modules/documents";
import { NumberingSeries } from "../../src/modules/numbering";
import type { TemplateRow } from "../../src/modules/recurring";
import { RecurringRepo, RecurringRepoMemory } from "../../src/modules/recurring";
import {
  BankAccountReferences,
  WorkspacesRepo,
  WorkspacesRepoMemory,
} from "../../src/modules/workspaces";
import { CoreStore } from "../../src/store/CoreStore";
import { member, WORKSPACE_A, WORKSPACE_B } from "../helpers";
import {
  as,
  B_BUYER,
  CZK,
  CZK_ACCOUNT,
  dec,
  EUR_ACCOUNT,
  fixing,
  invoiceInput,
  scenario,
} from "../modules/documents/fixtures";
import { templateInput } from "../modules/recurring/fixtures";

const NEW_ACCOUNT = "01900000-0000-7000-8000-0000ba000009" as BankAccountId;
const AT = "2026-11-23T09:00:00.000Z";
/** Default series per kind; an EUR fixing for the EUR draft. */
const OPTIONS = { billingA: { seriesByKind: {} }, fixings: [fixing("2026-11-23", "25.320")] };

const layer = BankAccountReferencesLive.pipe(
  Layer.provideMerge(Layer.mergeAll(RecurringRepoMemory, WorkspacesRepoMemory)),
);

const template = (
  id: string,
  overrides: Partial<TemplateRow> & { readonly bankAccount?: BankAccountId } = {},
): TemplateRow => {
  const { bankAccount, ...rest } = overrides;
  return {
    id: `01900000-0000-7000-8000-0000ee00000${id}` as TemplateId,
    workspaceId: WORKSPACE_A,
    revision: 1,
    name: `T${id}`,
    input: templateInput(bankAccount === undefined ? {} : { bankAccount }),
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...rest,
  };
};

/**
 * Workspace A: a draft that chose CZK_ACCOUNT, a draft that resolved it as the CZK default, an
 * EUR draft, an issued invoice on CZK_ACCOUNT, Templates (one naming it, one archived naming
 * it, one without an account). Workspace B: a draft and a Template on the same account id.
 */
const fixture = Effect.gen(function* () {
  const store = yield* CoreStore;
  yield* store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      n.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note"]),
    ),
  );
  const docs = yield* Documents;
  const chosen = yield* docs.createDraft(invoiceInput({ bankAccount: CZK_ACCOUNT }));
  const defaulted = yield* docs.createDraft(invoiceInput());
  const eur = yield* docs.createDraft(invoiceInput({ currency: "EUR" as never }));
  const issued = yield* docs.issue({ input: invoiceInput() });
  const otherDraft = yield* as(
    member("owner", { workspaceId: WORKSPACE_B }),
    docs.createDraft(
      invoiceInput({
        contact: B_BUYER,
        bankAccount: CZK_ACCOUNT,
        lines: [{ description: "Služba", unitPrice: dec("100") }],
      }),
    ),
  );
  const recurring = yield* RecurringRepo;
  const workspaces = yield* WorkspacesRepo;
  yield* store.transaction(
    Effect.gen(function* () {
      yield* recurring.insertTemplate(template("1", { bankAccount: CZK_ACCOUNT }));
      yield* recurring.insertTemplate(template("2", { bankAccount: CZK_ACCOUNT, archivedAt: AT }));
      yield* recurring.insertTemplate(template("3"));
      yield* recurring.insertTemplate(
        template("4", { bankAccount: CZK_ACCOUNT, workspaceId: WORKSPACE_B }),
      );
      yield* workspaces.insertBankAccount({
        id: NEW_ACCOUNT,
        workspaceId: WORKSPACE_A,
        revision: 1,
        name: "Nový účet",
        iban: "CZ6508000000192000145399",
        bic: "GIBACZPX",
        currency: CZK,
        archived: false,
        createdAt: AT,
      });
    }),
  );
  return { chosen, defaulted, eur, issued, otherDraft };
});

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

const record = (id: DocumentId, ws = WORKSPACE_A) =>
  Effect.flatMap(DocumentsRepo, (repo) => repo.get(ws, id));

describe("BankAccountReferencesLive", () => {
  test("count: drafts (chosen or resolved) and live Templates; not issued, archived or other Workspaces", async () => {
    const counts = ok(
      await scenario(
        Effect.gen(function* () {
          yield* fixture;
          const refs = yield* BankAccountReferences;
          return {
            czk: yield* refs.count(WORKSPACE_A, CZK_ACCOUNT),
            eur: yield* refs.count(WORKSPACE_A, EUR_ACCOUNT),
            fresh: yield* refs.count(WORKSPACE_A, NEW_ACCOUNT),
            otherWorkspace: yield* refs.count(WORKSPACE_B, CZK_ACCOUNT),
          };
        }).pipe(Effect.provide(layer)),
        OPTIONS,
      ),
    );
    // chosen + defaulted drafts, Template 1.
    expect(counts).toEqual({ czk: 3, eur: 1, fresh: 0, otherWorkspace: 2 });
  });

  test("reassign moves drafts and Templates in the transaction; issued documents keep their snapshot", async () => {
    const result = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* fixture;
          const refs = yield* BankAccountReferences;
          const store = yield* CoreStore;
          const before = {
            chosen: yield* record(f.chosen.id),
            issued: yield* record(f.issued.id),
          };
          yield* store.transaction(refs.reassign(WORKSPACE_A, CZK_ACCOUNT, NEW_ACCOUNT));
          const recurring = yield* RecurringRepo;
          return {
            before,
            counts: {
              from: yield* refs.count(WORKSPACE_A, CZK_ACCOUNT),
              to: yield* refs.count(WORKSPACE_A, NEW_ACCOUNT),
              otherWorkspace: yield* refs.count(WORKSPACE_B, CZK_ACCOUNT),
            },
            chosen: yield* record(f.chosen.id),
            defaulted: yield* record(f.defaulted.id),
            eur: yield* record(f.eur.id),
            issued: yield* record(f.issued.id),
            otherDraft: yield* record(f.otherDraft.id, WORKSPACE_B),
            t1: yield* recurring.getTemplate(WORKSPACE_A, template("1").id),
            t2: yield* recurring.getTemplate(WORKSPACE_A, template("2").id),
            t3: yield* recurring.getTemplate(WORKSPACE_A, template("3").id),
            t4: yield* recurring.getTemplate(WORKSPACE_B, template("4").id),
            view: yield* Effect.flatMap(Documents, (d) => d.get(f.chosen.id)),
          };
        }).pipe(Effect.provide(layer)),
        OPTIONS,
      ),
    );
    const snapshot = {
      id: NEW_ACCOUNT,
      name: "Nový účet",
      currency: CZK,
      accountNumber: "19-2000145399/0800",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    };
    expect(result.counts).toEqual({ from: 0, to: 3, otherWorkspace: 2 });
    // The chosen draft: choice and snapshot move, revision bumps.
    expect(result.chosen.given.bankAccount).toBe(NEW_ACCOUNT);
    expect(result.chosen.issuer.bankAccount).toEqual(snapshot);
    expect(result.chosen.revision).toBe(result.before.chosen.revision + 1);
    // The defaulted draft: no choice recorded, its resolved snapshot moves.
    expect(result.defaulted.given.bankAccount).toBeUndefined();
    expect(result.defaulted.issuer.bankAccount).toEqual(snapshot);
    expect(result.eur.issuer.bankAccount?.id).toBe(EUR_ACCOUNT);
    // Issued: untouched.
    expect(result.issued).toEqual(result.before.issued);
    // Other Workspace: untouched.
    expect(result.otherDraft.given.bankAccount).toBe(CZK_ACCOUNT);
    expect(result.t4.input.bankAccount).toBe(CZK_ACCOUNT);
    // Templates: the live one moves; archived and account-less ones stay.
    expect(result.t1.input.bankAccount).toBe(NEW_ACCOUNT);
    expect(result.t1.revision).toBe(2);
    expect(result.t2.input.bankAccount).toBe(CZK_ACCOUNT);
    expect(result.t3.input.bankAccount).toBeUndefined();
    expect(result.view.issuer).toMatchObject({ bankAccount: { id: NEW_ACCOUNT } });
  });

  test("a failed transaction rolls the reassignment back", async () => {
    const result = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* fixture;
          const refs = yield* BankAccountReferences;
          const store = yield* CoreStore;
          const failed = yield* Effect.exit(
            store.transaction(
              Effect.andThen(
                refs.reassign(WORKSPACE_A, CZK_ACCOUNT, NEW_ACCOUNT),
                Effect.fail("boom"),
              ),
            ),
          );
          const recurring = yield* RecurringRepo;
          return {
            failed,
            from: yield* refs.count(WORKSPACE_A, CZK_ACCOUNT),
            to: yield* refs.count(WORKSPACE_A, NEW_ACCOUNT),
            chosen: yield* record(f.chosen.id),
            t1: yield* recurring.getTemplate(WORKSPACE_A, template("1").id),
          };
        }).pipe(Effect.provide(layer)),
        OPTIONS,
      ),
    );
    expect(result.failed).toEqual(Exit.fail("boom"));
    expect({ from: result.from, to: result.to }).toEqual({ from: 3, to: 0 });
    expect(result.chosen.given.bankAccount).toBe(CZK_ACCOUNT);
    expect(result.chosen.issuer.bankAccount?.id).toBe(CZK_ACCOUNT);
    expect(result.t1.input.bankAccount).toBe(CZK_ACCOUNT);
    expect(result.t1.revision).toBe(1);
  });

  test("reassign with nothing to move, or onto itself, changes nothing", async () => {
    const result = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* fixture;
          const refs = yield* BankAccountReferences;
          const store = yield* CoreStore;
          const before = yield* record(f.chosen.id);
          yield* store.transaction(refs.reassign(WORKSPACE_A, CZK_ACCOUNT, CZK_ACCOUNT));
          yield* store.transaction(refs.reassign(WORKSPACE_A, NEW_ACCOUNT, CZK_ACCOUNT));
          return { before, after: yield* record(f.chosen.id) };
        }).pipe(Effect.provide(layer)),
        OPTIONS,
      ),
    );
    expect(result.after).toEqual(result.before);
  });

  test("reassign skips candidates discarded, moved off the account or archived after they were read", async () => {
    const result = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* fixture;
          const store = yield* CoreStore;
          const docsRepo = yield* DocumentsRepo;
          const recurring = yield* RecurringRepo;
          yield* store.transaction(
            recurring.insertTemplate(template("5", { bankAccount: CZK_ACCOUNT })),
          );
          // The candidates as read before the concurrent changes below.
          const staleDrafts = yield* docsRepo.draftsUsingBankAccount(WORKSPACE_A, CZK_ACCOUNT);
          const staleTemplates = yield* recurring.templatesUsingBankAccount(
            WORKSPACE_A,
            CZK_ACCOUNT,
          );
          // Concurrent changes: discard one draft, move the other off the account, archive T1.
          const chosen = yield* record(f.chosen.id);
          yield* Effect.flatMap(Documents, (d) => d.discardDraft(f.chosen.id, chosen.revision));
          yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* docsRepo.lock(WORKSPACE_A, f.defaulted.id);
              yield* docsRepo.update(
                { ...row, issuer: { ...row.issuer, bankAccount: null } },
                row.revision,
              );
              const t1 = yield* recurring.lockTemplateState(WORKSPACE_A, template("1").id);
              yield* recurring.updateTemplate({ ...t1, archivedAt: AT }, t1.revision);
            }),
          );
          const defaulted = yield* record(f.defaulted.id);
          // Fresh: the shared memo map would otherwise reuse the outer build over the real repos.
          const stale = Layer.fresh(BankAccountReferencesLive).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.effect(
                  DocumentsRepo,
                  Effect.map(DocumentsRepo, (repo) =>
                    DocumentsRepo.of({
                      ...repo,
                      draftsUsingBankAccount: () => Effect.succeed(staleDrafts),
                    }),
                  ),
                ),
                Layer.effect(
                  RecurringRepo,
                  Effect.map(RecurringRepo, (repo) =>
                    RecurringRepo.of({
                      ...repo,
                      templatesUsingBankAccount: () => Effect.succeed(staleTemplates),
                    }),
                  ),
                ),
              ),
            ),
          );
          yield* store.transaction(
            Effect.flatMap(BankAccountReferences, (refs) =>
              refs.reassign(WORKSPACE_A, CZK_ACCOUNT, NEW_ACCOUNT),
            ).pipe(Effect.provide(stale)),
          );
          return {
            staleIds: staleDrafts.map((d) => d.id),
            discarded: yield* Effect.exit(record(f.chosen.id)),
            defaultedBefore: defaulted,
            defaulted: yield* record(f.defaulted.id),
            t1: yield* recurring.getTemplate(WORKSPACE_A, template("1").id),
            t5: yield* recurring.getTemplate(WORKSPACE_A, template("5").id),
          };
        }).pipe(Effect.provide(layer)),
        OPTIONS,
      ),
    );
    expect(result.staleIds).toContain(result.defaulted.id);
    expect(Exit.isFailure(result.discarded)).toBe(true);
    // Moved off the account: not rewritten (no revision bump, no snapshot of the new account).
    expect(result.defaulted).toEqual(result.defaultedBefore);
    // Archived after the read: keeps its account.
    expect(result.t1.archivedAt).toBe(AT);
    expect(result.t1.input.bankAccount).toBe(CZK_ACCOUNT);
    expect(result.t1.revision).toBe(2);
    // A candidate still on the account moves.
    expect(result.t5.input.bankAccount).toBe(NEW_ACCOUNT);
  });
});
