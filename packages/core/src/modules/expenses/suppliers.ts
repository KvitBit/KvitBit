/**
 * `ExpenseSuppliers`: the narrow port through which Expenses links a supplier Contact. The
 * integration implements it on the domain `Contacts` tag (`get` for a ContactId, `fromIco` with
 * role "supplier" for an IČO), mapping the ContactView to a `SupplierRecord`. It runs as the
 * current caller, so the Contacts policy applies on top of `expense.write`: a Contact id needs
 * `contact.read`, an IČO (which may create the Contact) `contact.write`; a token scoped to
 * expenses only links a supplier typed by hand. The fake enforces the same policy.
 */

import type {
  Caller,
  ContactId,
  Forbidden,
  Invalid,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { authorize } from "../../policy/Policy";
import type { SupplierRecord } from "./model";
import { invalid } from "./model";

export class ExpenseSuppliers extends Context.Service<
  ExpenseSuppliers,
  {
    /** A Contact of the caller's Workspace; another Workspace's is `NotFound{Contact}`. */
    readonly contact: (
      caller: Caller,
      id: ContactId,
    ) => Effect.Effect<SupplierRecord, NotFound | Unavailable | Forbidden>;
    /** IČO -> saved supplier Contact (checksum, registry lookup, upsert by IČO); no record is `NotFound`. */
    readonly fromIco: (
      caller: Caller,
      ico: string,
    ) => Effect.Effect<SupplierRecord, Invalid | NotFound | Unavailable | Forbidden>;
  }
>()("@kvitbit/core/modules/expenses/suppliers/ExpenseSuppliers") {}

export interface FakeSupplier extends SupplierRecord {
  readonly workspaceId: WorkspaceId;
}

/** Test control of `FakeExpenseSuppliers`: the Contacts it knows. */
export class FakeSupplierDirectory extends Context.Service<
  FakeSupplierDirectory,
  { readonly contacts: Ref.Ref<ReadonlyArray<FakeSupplier>> }
>()("@kvitbit/core/modules/expenses/suppliers/FakeSupplierDirectory") {}

const strip = ({ workspaceId: _ws, ...record }: FakeSupplier): SupplierRecord => record;

/** In-memory `ExpenseSuppliers`: Workspace-scoped like Contacts; an unknown IČO fails `ico.checksum`. */
export const FakeExpenseSuppliers: Layer.Layer<ExpenseSuppliers | FakeSupplierDirectory> =
  Layer.effect(
    ExpenseSuppliers,
    Effect.map(FakeSupplierDirectory, (dir) => {
      const find = Effect.fn("find")(function* (
        caller: Caller,
        action: "contact.read" | "contact.write",
        match: (c: FakeSupplier) => boolean,
      ) {
        yield* authorize(caller, action);
        const ws = caller._tag === "Member" || caller._tag === "System" ? caller.workspaceId : null;
        const value = yield* Ref.get(dir.contacts);
        return Option.getOrUndefined(
          EffectArray.findFirst(value, (c) => c.workspaceId === ws && match(c)),
        );
      });
      return {
        contact: (caller: Caller, id: ContactId) =>
          Effect.flatMap(
            find(caller, "contact.read", (c) => c.contactId === id),
            (found) =>
              found === undefined
                ? Effect.fail(NotFound.make({ entity: "Contact", id }))
                : Effect.succeed(strip(found)),
          ),
        fromIco: (caller: Caller, ico: string) =>
          Effect.flatMap(
            find(caller, "contact.write", (c) => c.ico === ico),
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
