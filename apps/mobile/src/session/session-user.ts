import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The signed-in user from Better Auth `get-session` (`{ session, user }` or null). */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

const sessionResponse = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    name: Schema.optional(Schema.Unknown),
    emailVerified: Schema.optional(Schema.Unknown),
  }),
});

export const readSessionUser = <Body>(body: Body): SessionUser | null =>
  Option.match(Schema.decodeUnknownOption(sessionResponse)(body), {
    onNone: () => null,
    onSome: ({ user }) => ({
      id: user.id,
      email: user.email,
      name: Predicate.isString(user.name) ? user.name : "",
      emailVerified: user.emailVerified === true,
    }),
  });
