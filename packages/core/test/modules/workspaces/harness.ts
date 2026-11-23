/** Test harness for the Workspaces module: real layers over the in-memory ports. */
import type {
  AuditEntry,
  Caller,
  MemberCaller,
  Role,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import type { Exit } from "effect";
import { Effect, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import {
  CaptureInvitationDelivery,
  type DirectoryUser,
  InvitationTokens,
  WorkspacesTestLayer,
} from "../../../src/modules/workspaces";
import { CoreStore } from "../../../src/store/CoreStore";
import { InMemoryPortsLive } from "../../../src/testing";
import { account, TEST_NOW } from "../../helpers";

const user = (n: number) => `01900000-0000-7000-8000-00000000c00${n}` as UserId;
export const OWNER = user(1);
export const ADMIN = user(2);
export const MEMBER = user(3);
export const ACCOUNTANT = user(4);
export const OUTSIDER = user(5);
export const SECOND_ADMIN = user(6);

export const USERS: ReadonlyArray<DirectoryUser> = [
  { userId: OWNER, name: "Olga Owner", email: "owner@example.cz" },
  { userId: ADMIN, name: "Adam Admin", email: "admin@example.cz" },
  { userId: MEMBER, name: "Marie Member", email: "member@example.cz" },
  { userId: ACCOUNTANT, name: "Alena Accountant", email: "accountant@example.cz" },
  { userId: OUTSIDER, name: "Otto Outsider", email: "outsider@example.cz" },
  { userId: SECOND_ADMIN, name: "Bara Admin", email: "admin2@example.cz" },
];

export const emailOf = (userId: UserId) => USERS.find((u) => u.userId === userId)?.email ?? "";
export const accountOf = (userId: UserId) => account({ userId, email: emailOf(userId) });

/** Valid IČO with a registry record; and one whose checksum fails. */
export const ICO = "27082440";
export const BAD_ICO = "27082441";
export const UNKNOWN_ICO = "25596641";
export const RECORD: RegistryRecord = {
  name: "Alfa Beta s.r.o.",
  address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27082440",
  legalForm: "s.r.o.",
  registerEntry: "C 12345 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

const env = Layer.merge(InMemoryPortsLive({ registry: { [ICO]: RECORD } }), TestClock.layer());
const layer = WorkspacesTestLayer(USERS).pipe(Layer.provideMerge(env));
type Env = Layer.Success<typeof layer>;

/** Runs a scenario on fresh layers with the TestClock at TEST_NOW. */
export const run = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(Effect.provide(layer)),
  );

/** Runs `effect` as `caller`. */
export const as =
  (caller: Caller) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
    Effect.provideService(effect, CurrentCaller, caller);

export const W = Effect.service(Workspaces);

/** The token of the latest invitation email. */
export const lastToken = Effect.gen(function* () {
  const capture = yield* CaptureInvitationDelivery;
  const sent = yield* Ref.get(capture.sent);
  const last = sent[sent.length - 1];
  if (last === undefined) return yield* Effect.die("no invitation sent");
  const tokens = yield* InvitationTokens;
  return yield* tokens.token(last.invitationId, last.epoch);
});

export interface Seeded {
  readonly workspaceId: WorkspaceId;
  readonly owner: MemberCaller;
  readonly admin: MemberCaller;
  readonly member: MemberCaller;
  readonly accountant: MemberCaller;
}

/** Joins `userId` as `role` through invite (by `inviter`) and accept. */
export const join = (inviter: MemberCaller, userId: UserId, role: Exclude<Role, "owner">) =>
  Effect.gen(function* () {
    const ws = yield* W;
    yield* as(inviter)(ws.invite(emailOf(userId), role));
    const token = yield* lastToken;
    return yield* as(accountOf(userId))(ws.acceptInvitation(token as never));
  });

/** Acme with an owner, an admin, a member and an accountant. */
export const seed = (name = "Acme s.r.o.") =>
  Effect.gen(function* () {
    const ws = yield* W;
    const owner = yield* as(accountOf(OWNER))(ws.create({ name } as never));
    const admin = yield* join(owner, ADMIN, "admin");
    const member = yield* join(owner, MEMBER, "member");
    const accountant = yield* join(owner, ACCOUNTANT, "accountant");
    const seeded: Seeded = { workspaceId: owner.workspaceId, owner, admin, member, accountant };
    return seeded;
  });

/** A token caller of `base` narrowed to `scopes`. */
export const scoped = (base: MemberCaller, scopes: MemberCaller["scopes"]): MemberCaller => ({
  ...base,
  scopes,
  channel: "api",
  client: { kind: "api_key", id: "key-1", name: "CI key" },
});

export const history = (workspaceId: WorkspaceId, subject?: AuditEntry["subject"]) =>
  Effect.flatMap(Effect.service(CoreStore), (store) =>
    store.audit.history(workspaceId, subject ?? { entity: "Workspace", id: workspaceId }),
  );

/** Runs a scenario whose `expect`s run inside; rejects on any failure or defect. */
export const scenario = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(Effect.provide(layer)),
  );

/** The expected failure of `effect`; a success fails the scenario. */
export const failure = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, A, R> =>
  Effect.flip(effect);
