/**
 * The signed-in viewer: the Better Auth session user plus the workspaces they belong to
 * (myWorkspaces.listMine). `Unknown` until the first check returns, so the Shell can render a
 * skeleton instead of flashing the sign-in screen.
 */
import { WorkspaceSummary } from "@kvitbit/domain";
import { Effect, Option, Schema } from "effect";
import { authFetch, Failure, request, type WebServices } from "./api";

export const SessionUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  feedbackEnabled: Schema.optionalKey(Schema.Boolean),
});
export type SessionUser = typeof SessionUser.Type;

export const SessionState = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Anonymous", {}),
  Schema.TaggedStruct("SignedIn", {
    user: SessionUser,
    workspaces: Schema.Array(WorkspaceSummary),
  }),
  Schema.TaggedStruct("Unavailable", { failure: Failure }),
]);
export type SessionState = typeof SessionState.Type;

const BetterAuthSession = Schema.NullOr(
  Schema.Struct({
    feedbackEnabled: Schema.optionalKey(Schema.Boolean),
    user: Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      emailVerified: Schema.optionalKey(Schema.Boolean),
    }),
  }),
);
const decodeSession = Schema.decodeUnknownOption(BetterAuthSession);

type Lookup =
  | { readonly _tag: "User"; readonly user: SessionUser }
  | { readonly _tag: "None" }
  | { readonly _tag: "Failed"; readonly failure: Failure };

const toUser = (json: unknown): Lookup =>
  Option.match(decodeSession(json).pipe(Option.flatMap(Option.fromNullishOr)), {
    onNone: (): Lookup => ({ _tag: "None" }),
    onSome: ({ feedbackEnabled, user: u }): Lookup => ({
      _tag: "User",
      user: {
        id: u.id,
        email: u.email,
        name: u.name ?? u.email,
        emailVerified: u.emailVerified ?? false,
        feedbackEnabled: feedbackEnabled === true && u.emailVerified === true,
      },
    }),
  });

/** Better Auth `get-session`, then the caller's workspaces. Never fails. */
export const fetchSession: Effect.Effect<SessionState, never, WebServices> = authFetch(
  "/get-session",
  {},
  toUser,
  (failure): Lookup => ({ _tag: "Failed", failure }),
).pipe(
  Effect.andThen((lookup): Effect.Effect<SessionState, never, WebServices> => {
    switch (lookup._tag) {
      case "None":
        return Effect.succeed({ _tag: "Anonymous" });
      case "Failed":
        return Effect.succeed(
          lookup.failure.tag === "Unauthorized"
            ? { _tag: "Anonymous" }
            : { _tag: "Unavailable", failure: lookup.failure },
        );
      case "User":
        return request(
          (client) => client.myWorkspaces.listMine(),
          (workspaces): SessionState => ({ _tag: "SignedIn", user: lookup.user, workspaces }),
          (failure): SessionState =>
            failure.tag === "Unauthorized"
              ? { _tag: "Anonymous" }
              : { _tag: "Unavailable", failure },
        );
    }
  }),
);

export const workspaceBySlug = (
  state: SessionState,
  slug: string,
): Option.Option<WorkspaceSummary> =>
  state._tag === "SignedIn"
    ? Option.fromNullishOr(state.workspaces.find((w) => w.slug === slug))
    : Option.none();
