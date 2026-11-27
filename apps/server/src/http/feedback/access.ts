import { SESSION_COOKIE } from "@kvitbit/api-contract";
import { Effect, Redacted, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { SqlClient } from "effect/sql";

export interface FeedbackConfig {
  readonly token: Redacted.Redacted<string>;
  readonly repository: string;
  readonly ownerEmails: ReadonlySet<string>;
}

const repositoryName = /^(?=[^/]{1,39}\/)[a-z\d]+(?:-[a-z\d]+)*\/([a-z\d_.-]{1,100})$/i;
const githubToken = /^(?:github_pat_[a-zA-Z\d]{22}_[a-zA-Z\d]{59}|gh[opsu]_[a-zA-Z\d]{36})$/;
const GITHUB_TOKEN_MAX_BYTES = 8 * 1024;
// GitHub's stateless installation tokens are variable-length ghs_APPID_JWT values.
const statelessInstallationToken = /^ghs_(?=.{36,}$)\d+_[a-zA-Z\d_-]+(?:\.[a-zA-Z\d_-]+){2}$/;
const emailAddress =
  /^[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/;

export const makeFeedbackConfig = (
  token: Redacted.Redacted<string> | undefined,
  repository: string,
  emails: string,
): FeedbackConfig | undefined => {
  if (token === undefined) return undefined;
  const name = repositoryName.exec(repository)?.[1];
  const credential = Redacted.value(token);
  const ownerEmails = emails.split(",").map((email) => email.trim().toLowerCase());
  if (
    Buffer.byteLength(credential, "utf8") > GITHUB_TOKEN_MAX_BYTES ||
    (!githubToken.test(credential) && !statelessInstallationToken.test(credential)) ||
    name === undefined ||
    name === "." ||
    name === ".." ||
    ownerEmails.some((email) => email.length > 254 || !emailAddress.test(email))
  ) {
    return undefined;
  }
  return { token, repository, ownerEmails: new Set(ownerEmails) };
};

export const feedbackSessionCookie = (request: HttpServerRequest): string | undefined =>
  request.headers.authorization === undefined &&
  (request.cookies[SESSION_COOKIE] || request.cookies["kvitbit.session_token"])
    ? request.headers.cookie
    : undefined;

export const FeedbackSessionUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
});

export const canSubmitFeedback = (
  sql: SqlClient.SqlClient,
  config: FeedbackConfig | undefined,
  user: typeof FeedbackSessionUser.Type,
) =>
  Effect.gen(function* () {
    const email = user.email.toLowerCase();
    if (config === undefined || !user.emailVerified || !config.ownerEmails.has(email)) return false;

    const rows = yield* sql`
      select id from auth."user"
      where id = ${user.id} and lower(email) = ${email} and email_verified and deleted_at is null
      limit 1`;
    return rows.length === 1;
  }).pipe(Effect.orElseSucceed(() => false));
