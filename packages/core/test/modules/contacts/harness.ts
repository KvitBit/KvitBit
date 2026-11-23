/** Shared helpers for the Contacts and PriceList module tests. */
import { expect } from "bun:test";
import type { AuditEntry, Caller, ContactInput, WorkspaceId } from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import { Cause, Effect, Exit, Option } from "effect";
import { CoreStore } from "../../../src/store/CoreStore";

export const ACME_ICO = "27074358";
export const CEZ_ICO = "45274649";
/** Passes the checksum; the fake registry has no record of it. */
export const UNKNOWN_ICO = "25596641";
export const BAD_ICO = "27074359";

export const acmeRecord: RegistryRecord = {
  name: "Acme s.r.o.",
  address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27074358",
  legalForm: "112",
  registerEntry: "C 12345 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

export const registry = { [ACME_ICO]: acmeRecord };

/** Runs `effect` as another caller inside one test. */
export const as =
  (caller: Caller) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
    Effect.provideService(effect, CurrentCaller, caller);

/** The success value, failing the test with the cause otherwise. */
export const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
};

/** The expected failure of `exit`. */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) return failure.value;
    throw new Error(`expected a failure, got ${Cause.pretty(exit.cause)}`);
  }
  throw new Error("expected a failure, got success");
};

/** Asserts a tagged failure with the given fields. */
export const expectFailure = (
  exit: Exit.Exit<unknown, unknown>,
  expected: Record<string, unknown>,
) => expect(failureOf(exit)).toMatchObject(expected);

export const history = (
  workspaceId: WorkspaceId,
  subject: AuditEntry["subject"],
): Effect.Effect<ReadonlyArray<AuditEntry>, never, CoreStore> =>
  Effect.flatMap(CoreStore, (store) => store.audit.history(workspaceId, subject)).pipe(
    Effect.orDie,
  );

/** `ContactInput` with open particulars. */
export const contactInput = (fields: Record<string, unknown>): ContactInput =>
  fields as ContactInput;
