import { afterEach, expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import { BotProtection, BotProtectionUnavailable, InvalidBotProof } from "@kvitbit/adapters/altcha";
import { InvitationTokens } from "@kvitbit/core";
import { CaptureEmailSender } from "@kvitbit/core/testing";
import { CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { type Harness, json, makeHarness, ORIGIN } from "./harness";

const emailLink = /https:\/\/\S+/;
const sqlLog = /Failed query:|params:/;
const password = "A test password for Better Auth";
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const setup = () => {
  const used = new Set<string>();
  const botProtection = Layer.succeed(BotProtection, {
    issue: () => Effect.fail(BotProtectionUnavailable.make({})),
    verify: (scope, payload) => {
      if (!EffectString.startsWith(`${scope}:`)(payload)) {
        return Effect.fail(InvalidBotProof.make({ reason: "invalid_solution" }));
      }
      if (EffectString.endsWith(":unavailable")(payload))
        return Effect.fail(BotProtectionUnavailable.make({}));
      if (used.has(payload)) return Effect.fail(InvalidBotProof.make({ reason: "replayed" }));
      used.add(payload);
      return Effect.void;
    },
  });
  const app = makeHarness({ principalResolver: "live", botProtection });
  harness = app;
  const owner = app.addUser("Owner");
  const workspace = app.createWorkspace(owner);

  const invite = async (email: string) => {
    const caller = await workspace;
    return app.run(
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const tokens = yield* InvitationTokens;
        const invitation = yield* workspaces.invite(email, "accountant");
        const token = yield* tokens.token(invitation.id, 0);
        return { token, id: invitation.id };
      }).pipe(Effect.provideService(CurrentCaller, caller)),
    );
  };
  const signUp = (email: string, proof: string, fields = {}, origin = ORIGIN) =>
    app.fetch("/api/auth/sign-up/email", {
      ...json({ name: "Invitee", email, password, ...fields }),
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-altcha": proof },
    });
  const accept = (token: string, cookie?: string) => {
    const headers = new Headers({ origin: ORIGIN });
    if (cookie !== undefined) headers.set("cookie", cookie);
    return app.fetch(`/api/v1/invitations/${token}/accept`, { method: "POST", headers });
  };
  const verificationEmails = () =>
    app.run(
      Effect.gen(function* () {
        const capture = yield* CaptureEmailSender;
        const sent = yield* Ref.get(capture.sent);
        return EffectArray.filter(sent, ({ message }) => message.tags?.["template"] === "E01");
      }),
    );
  return { app, workspace, invite, signUp, accept, verificationEmails };
};

const sessionCookie = (response: Response) =>
  EffectArray.findFirst(
    response.headers.getSetCookie(),
    EffectString.startsWith("__Secure-kvitbit.session_token="),
  ).pipe(
    Option.map((value) => EffectString.split(value, ";")[0]),
    Option.getOrUndefined,
  );

test("invitation signup verifies the invited address and creates a session that can accept through core", async () => {
  const { app, workspace, invite, signUp, accept, verificationEmails } = setup();
  const email = "invitee@example.cz";
  const { token } = await invite(email);
  const other = await invite("other-invitee@example.cz");

  expect((await accept(token)).status).toBe(401);
  const signup = await signUp(EffectString.toUpperCase(email), "invitation_accept:create", {
    invitationToken: token,
  });
  expect(signup.status).toBe(200);
  expect(await signup.json()).toMatchObject({ user: { email, emailVerified: true } });
  expect(await verificationEmails()).toEqual([]);
  const cookie = sessionCookie(signup);
  expect(cookie).toBeDefined();

  const preview = await app.fetch(`/api/v1/invitations/${token}`);
  expect(await preview.json()).toMatchObject({ status: "pending" });
  expect((await accept(other.token, cookie)).status).toBe(403);
  const accepted = await accept(token, cookie);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    id: (await workspace).workspaceId,
    role: "accountant",
  });
  expect((await accept(token, cookie)).status).toBe(409);

  // The same session can start the existing signed-in passkey registration flow.
  const optionsPath = "/api/auth/passkey/generate-register-options?name=Phone";
  expect((await app.fetch(optionsPath)).status).toBe(401);
  const options = await app.fetch(optionsPath, { headers: { cookie: cookie ?? "" } });
  expect(options.status).toBe(200);
  expect(await options.json()).toMatchObject({
    challenge: expect.any(String),
    rp: { id: new URL(ORIGIN).hostname },
    user: { name: "Phone", displayName: email },
  });
  expect(
    EffectArray.some(options.headers.getSetCookie(), EffectString.includes("better-auth-passkey")),
  ).toBe(true);
  const bearer = signup.headers.get("set-auth-token");
  expect(bearer).toBeTruthy();
  expect(
    (await app.fetch(optionsPath, { headers: { authorization: `Bearer ${bearer}` } })).status,
  ).toBe(200);
});

test("invalid invitation signup attempts leave accounts and memberships unchanged", async () => {
  const { app, workspace, invite, signUp } = setup();
  const email = "pending@example.cz";
  const { token } = await invite(email);
  const revoked = await invite("revoked@example.cz");
  const expired = await invite("expired@example.cz");

  expect((await signUp(email, "sign_up:wrong-scope", { invitationToken: token })).status).toBe(400);
  expect((await signUp(email, "invitation_accept:ordinary")).status).toBe(400);
  const outage = await signUp(email, "invitation_accept:unavailable", { invitationToken: token });
  expect(outage.status).toBe(503);
  expect(outage.headers.get("retry-after")).toBe("5");
  expect((await signUp(email, "invitation_accept:missing", { invitationToken: null })).status).toBe(
    400,
  );
  expect(
    (
      await signUp(email, "invitation_accept:ambiguous", {
        invitationToken: token,
        invitation: "wrong",
      })
    ).status,
  ).toBe(400);
  expect(
    (await signUp(email, "invitation_accept:unknown", { invitationToken: "unknown" })).status,
  ).toBe(404);
  expect(
    (await signUp("other@example.cz", "invitation_accept:mismatch", { invitationToken: token }))
      .status,
  ).toBe(403);
  expect(
    (
      await signUp(
        email,
        "invitation_accept:origin",
        { invitationToken: token },
        "https://outside.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (await signUp(email, "invitation_accept:mismatch", { invitationToken: token })).status,
  ).toBe(400);

  const caller = await workspace;
  await app.run(
    Effect.gen(function* () {
      const workspaces = yield* Workspaces;
      yield* workspaces.revokeInvitation(revoked.id);
    }).pipe(Effect.provideService(CurrentCaller, caller)),
  );
  expect(
    (
      await signUp("revoked@example.cz", "invitation_accept:revoked", {
        invitationToken: revoked.token,
      })
    ).status,
  ).toBe(404);
  await app.run(TestClock.adjust("8 days"));
  expect(
    (
      await signUp("expired@example.cz", "invitation_accept:expired", {
        invitationToken: expired.token,
      })
    ).status,
  ).toBe(404);

  const users = await app.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`select id from auth."user"`;
    }),
  );
  expect(users).toEqual([]);
});

test("ordinary signup still verifies by email and an existing user can sign in to accept an invite", async () => {
  const { app, invite, signUp, accept, verificationEmails } = setup();
  const email = "existing@example.cz";
  const ordinary = await signUp(email, "sign_up:ordinary", { emailVerified: true });
  expect(ordinary.status).toBe(200);
  expect(await ordinary.json()).toMatchObject({ token: null, user: { emailVerified: false } });
  expect(sessionCookie(ordinary)).toBeUndefined();
  const [verification] = await verificationEmails();
  const verificationLink = emailLink.exec(verification?.message.text ?? "")?.[0];
  expect(verificationLink).toBeDefined();
  const url = new URL(verificationLink ?? ORIGIN);
  expect((await app.fetch(`${url.pathname}${url.search}`)).status).toBe(302);

  const { token } = await invite(email);
  const duplicate = await signUp(email, "invitation_accept:existing", {
    invitation: token,
    password: "Some other password",
  });
  expect(duplicate.status).toBe(422);
  expect(sessionCookie(duplicate)).toBeUndefined();

  const signedIn = await app.fetch("/api/auth/sign-in/email", {
    ...json({ email, password }),
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-altcha": "sign_in:existing" },
  });
  expect(signedIn.status).toBe(200);
  const cookie = sessionCookie(signedIn);
  expect(cookie).toBeDefined();
  expect((await accept(token, cookie)).status).toBe(200);
});

test("invited signup rolls back failed inserts without logging SQL and can retry", async () => {
  const { app, invite, signUp, verificationEmails } = setup();
  const email = "retry@example.cz";
  const { token } = await invite(email);

  const checkRollback = async (table: "user" | "session", status: number) => {
    await app.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`alter table auth.${sql(table)} add constraint fail_auth_insert check (false)`;
      }),
    );

    const log = spyOn(console, "error").mockReturnValue(undefined);
    try {
      const failed = await signUp(email, `invitation_accept:abort-${table}`, { invitation: token });
      expect(failed.status).toBe(status);
      expect(sessionCookie(failed)).toBeUndefined();
      const leakedSql = EffectArray.some(log.mock.calls, (args) => sqlLog.test(inspect(args)));
      expect(leakedSql).toBe(false);
    } finally {
      log.mockRestore();
    }

    await app.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* sql`select id from auth."user"`;
        const accounts = yield* sql`select id from auth.account`;
        expect(users).toEqual([]);
        expect(accounts).toEqual([]);
        yield* sql`alter table auth.${sql(table)} drop constraint fail_auth_insert`;
      }),
    );
  };
  await checkRollback("user", 422);
  await checkRollback("session", 500);

  const [invited, ordinary] = await Promise.all([
    signUp(email, "invitation_accept:retry", { invitation: token }),
    signUp("ordinary@example.cz", "sign_up:concurrent"),
  ]);
  expect(invited.status).toBe(200);
  expect(await invited.json()).toMatchObject({ user: { emailVerified: true } });
  expect(sessionCookie(invited)).toBeDefined();
  expect(ordinary.status).toBe(200);
  expect(await ordinary.json()).toMatchObject({ token: null, user: { emailVerified: false } });
  expect(sessionCookie(ordinary)).toBeUndefined();
  expect(EffectArray.map(await verificationEmails(), ({ message }) => message.to)).toEqual([
    ["ordinary@example.cz"],
  ]);
});
