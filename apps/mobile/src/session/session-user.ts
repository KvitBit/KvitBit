/** The signed-in user from Better Auth `get-session` (`{ session, user }` or null). */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null;

export const readSessionUser = (body: unknown): SessionUser | null => {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const { id, email, name, emailVerified } = body.user;
  if (typeof id !== "string" || typeof email !== "string") return null;
  return {
    id,
    email,
    name: typeof name === "string" ? name : "",
    emailVerified: emailVerified === true,
  };
};
