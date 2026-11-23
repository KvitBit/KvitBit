/**
 * `ExpenseSuppliers`: the narrow port through which Expenses links a supplier Contact. The
 * integration implements it on the domain `Contacts` tag (`get` for a ContactId, `fromIco` with
 * role "supplier" for an IČO), mapping the ContactView to a `SupplierRecord`. Runs as the
 * current caller, so the Contacts policy applies.
 */
import type {
  ContactId,
  Forbidden,
  Invalid,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, NotFound } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref } from "effect";
import type { SupplierRecord } from "./model";
import { invalid } from "./model";

export class ExpenseSuppliers extends Context.Service<
  ExpenseSuppliers,
  {
    /** A Contact of the caller's Workspace; another Workspace's is `NotFound{Contact}`. */
    readonly contact: (
      id: ContactId,
    ) => Effect.Effect<SupplierRecord, NotFound | Forbidden, CurrentCaller>;
    /** IČO -> saved supplier Contact (checksum, registry lookup, upsert by IČO). */
    readonly fromIco: (
      ico: string,
    ) => Effect.Effect<SupplierRecord, Invalid | Unavailable | Forbidden, CurrentCaller>;
  }
>()("kvitbit/core/ExpenseSuppliers") {}

export interface FakeSupplier extends SupplierRecord {
  readonly workspaceId: WorkspaceId;
}

/** Test control of `FakeExpenseSuppliers`: the Contacts it knows. */
export class FakeSupplierDirectory extends Context.Service<
  FakeSupplierDirectory,
  { readonly contacts: Ref.Ref<ReadonlyArray<FakeSupplier>> }
>()("kvitbit/core/testing/FakeSupplierDirectory") {}

const strip = ({ workspaceId: _ws, ...record }: FakeSupplier): SupplierRecord => record;

const workspaceOf = Effect.map(CurrentCaller, (c) =>
  c._tag === "Member" || c._tag === "System" ? c.workspaceId : null,
);

/** In-memory `ExpenseSuppliers`: Workspace-scoped like Contacts; an unknown IČO fails `ico.checksum`. */
export const FakeExpenseSuppliers: Layer.Layer<ExpenseSuppliers | FakeSupplierDirectory> =
  Layer.effect(
    ExpenseSuppliers,
    Effect.map(FakeSupplierDirectory, (dir) => {
      const find = (match: (c: FakeSupplier) => boolean) =>
        Effect.gen(function* () {
          const ws = yield* workspaceOf;
          return (yield* Ref.get(dir.contacts)).find((c) => c.workspaceId === ws && match(c));
        });
      return {
        contact: (id: ContactId) =>
          Effect.flatMap(
            find((c) => c.contactId === id),
            (found) =>
              found === undefined
                ? Effect.fail(new NotFound({ entity: "Contact", id }))
                : Effect.succeed(strip(found)),
          ),
        fromIco: (ico: string) =>
          Effect.flatMap(
            find((c) => c.ico === ico),
            (found) =>
              found === undefined
                ? Effect.fail(invalid("ico.checksum", ["supplier", "ico"]))
                : Effect.succeed(strip(found)),
          ),
      };
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        FakeSupplierDirectory,
        Effect.map(Ref.make<ReadonlyArray<FakeSupplier>>([]), (contacts) => ({ contacts })),
      ),
    ),
  );
