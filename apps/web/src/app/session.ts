/**
 * The signed-in viewer: the Better Auth session user plus the workspaces they belong to
 * (myWorkspaces.listMine). `Unknown` until the first check returns, so the Shell can render a
 * skeleton instead of flashing the sign-in screen.
 */

import { WorkspaceSummary } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { authFetch, Failure, request, type WebServices } from "./api";

const SessionUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  feedbackEnabled: Schema.optionalKey(Schema.Boolean),
});
type SessionUser = typeof SessionUser.Type;

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
      name: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
      emailVerified: Schema.optionalKey(Schema.Boolean),
    }),
  }),
);
const decodeSession = Schema.decodeUnknownOption(BetterAuthSession);

type Lookup =
  | { readonly _tag: "User"; readonly user: SessionUser }
  | { readonly _tag: "None" }
  | { readonly _tag: "Failed"; readonly failure: Failure };

const toUser = (json: Schema.Json): Lookup =>
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

const workspaceBySlugImpl = (state: SessionState, slug: string): Option.Option<WorkspaceSummary> =>
  state._tag === "SignedIn"
    ? Option.fromNullishOr(
        Arr.findFirst(state.workspaces, (w) => w.slug === slug).pipe(Option.getOrUndefined),
      )
    : Option.none();

export const workspaceBySlug: {
  (slug: string): (state: SessionState) => Option.Option<WorkspaceSummary>;
  (state: SessionState, slug: string): Option.Option<WorkspaceSummary>;
} = Fn.dual(2, workspaceBySlugImpl);
