import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { makeFeedbackConfig } from "../../src/http/feedback/access";
import { captureAnalytics } from "../analytics-fixture";
import { json, makeHarness, ORIGIN } from "./harness";

const decodeResponse = Schema.decodeUnknownResult(
  Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
);

const ownerEmail = "owner@example.cz";
const secondOwnerEmail = "second-owner@example.cz";
const token = `ghs_12345_${EffectString.repeat(36)("a")}.${EffectString.repeat(200)("b-")}.${EffectString.repeat(43)("c_")}`;
const configured = makeFeedbackConfig(
  Redacted.make(token),
  "example/kvitbit",
  `${ownerEmail},${secondOwnerEmail}`,
);
const issueResponse = async (..._args: Parameters<typeof fetch>) =>
  Response.json({ number: 42 }, { status: 201 });
const upstream = mock(issueResponse);
const analytics = captureAnalytics();
const app = makeHarness({
  analytics: analytics.layer,
  config: { feedback: configured },
  feedbackFetch: Object.assign(upstream, { preconnect: () => undefined }),
});
const password = "A test password for Better Auth";

const authPost = (path: string, fields: { name?: string; email: string; password: string }) =>
  app.fetch(`/api/auth/${path}`, {
    ...json(fields),
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
  });

const setVerified = (email: string, verified: boolean) =>
  app.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`update auth."user" set email_verified = ${verified} where email = ${email}`;
    }),
  );

const sessionFor = async (email: string) => {
  const signup = await authPost("sign-up/email", { name: email, email, password });
  if (signup.status !== 200) throw new Error(`Better Auth signup returned ${signup.status}`);
  const { user } = decodeResponse(await signup.json()).pipe(Result.getOrThrow);
  await setVerified(email, true);
  const signin = await authPost("sign-in/email", { email, password });
  if (signin.status !== 200) throw new Error(`Better Auth signin returned ${signin.status}`);
  const [cookie] = EffectString.split(
    Option.getOrElse(
      EffectArray.findFirst(
        signin.headers.getSetCookie(),
        EffectString.startsWith("__Secure-kvitbit.session_token="),
      ),
      () => "",
    ),
    ";",
  );
  const bearer = signin.headers.get("set-auth-token");
  if (cookie === "" || bearer === null || bearer === "") {
    throw new Error("Better Auth did not return session credentials");
  }
  return { cookie, authorization: `Bearer ${bearer}`, userId: user.id };
};

const pin = {
  selector: "main > button:nth-of-type(1)",
  domPath: "main > button:nth-of-type(1)",
  tag: "button",
  accessibleName: "Send",
  role: "button",
  rect: { x: 3.5, y: 4, width: 119, height: 24 },
  text: "Send",
  styles: {
    display: "block",
    position: "static",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgb(255, 255, 255)",
    fontSize: "14px",
    fontWeight: "400",
  },
};

const diagnostic = { kind: "warn", timestamp: 1_700_000_000_000 };

const feedbackUrl = new URL("/w/alfa", ORIGIN);
feedbackUrl.username = "account";
feedbackUrl.password = "url-password";
feedbackUrl.searchParams.set("token", "query-token");
feedbackUrl.hash = "secret-fragment";

const feedback = {
  comment: "The button wraps\n```\n[@someone](https://untrusted.test)",
  pins: [pin],
  page: {
    url: feedbackUrl.href,
    locale: "en",
    theme: "dark",
    viewport: { width: 1024, height: 768 },
    dpr: 1.25,
  },
  diagnostics: [diagnostic],
};

const getSession = (headers?: RequestInit["headers"]) =>
  app.fetch("/api/auth/get-session", headers === undefined ? {} : { headers });

const submit = (headers?: RequestInit["headers"], body = feedback) => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return app.fetch("/api/feedback", {
    ...json(body),
    method: "POST",
    headers: requestHeaders,
  });
};

let owner: Awaited<ReturnType<typeof sessionFor>>;
let other: typeof owner;

beforeAll(async () => {
  owner = await sessionFor(ownerEmail);
  other = await sessionFor("other@example.cz");
}, 20_000);

beforeEach(async () => {
  await app.run(TestClock.adjust("1 minute"));
  upstream.mockReset().mockImplementation(issueResponse);
  analytics.capture.mockClear();
});

afterAll(async () => app.dispose());

const ownerHeaders = () => ({ origin: ORIGIN, cookie: owner.cookie });

test("only a cookie session for a verified owner advertises and can submit feedback", async () => {
  expect(await (await getSession()).json()).toBeNull();
  const ownerSession = await getSession({ cookie: owner.cookie });
  expect(ownerSession.headers.get("cache-control")).toBe("no-store");
  expect(await ownerSession.json()).toMatchObject({
    feedbackEnabled: true,
    user: { email: ownerEmail },
  });
  expect(await (await getSession({ authorization: owner.authorization })).json()).toMatchObject({
    feedbackEnabled: false,
    user: { email: ownerEmail },
  });
  expect(await (await getSession({ cookie: other.cookie })).json()).toMatchObject({
    feedbackEnabled: false,
  });
  expect((await submit({ origin: ORIGIN })).status).toBe(403);
  expect((await submit({ origin: ORIGIN, cookie: other.cookie })).status).toBe(403);
  expect((await submit({ origin: ORIGIN, authorization: owner.authorization })).status).toBe(403);

  await setVerified(ownerEmail, false);
  try {
    expect(await (await getSession({ cookie: owner.cookie })).json()).toMatchObject({
      feedbackEnabled: false,
    });
    expect((await submit({ origin: ORIGIN, cookie: owner.cookie })).status).toBe(403);
  } finally {
    await setVerified(ownerEmail, true);
  }
  expect(upstream).not.toHaveBeenCalled();
});

test("trusted Origin and strict bounded JSON are required before contacting GitHub", async () => {
  const rejectedOrigins = await Array.fromAsync(
    ["https://other.test", `${ORIGIN}/path`, "null", `${ORIGIN}, ${ORIGIN}`],
    async (origin) => (await submit({ ...ownerHeaders(), origin })).status,
  );
  expect(rejectedOrigins).toEqual([403, 403, 403, 403]);
  expect((await submit({ cookie: owner.cookie, referer: `${ORIGIN}/app/` })).status).toBe(403);

  const invalidBodies = [
    { ...feedback, comment: " " },
    { ...feedback, pins: [] },
    { ...feedback, pins: Array.from({ length: 9 }, () => pin) },
    { ...feedback, comment: EffectString.repeat(2_001)("a") },
    {
      ...feedback,
      pins: [{ ...pin, styles: { ...pin.styles, fontSize: EffectString.repeat(101)("a") } }],
    },
    { ...feedback, diagnostics: [{ ...diagnostic, message: "private console text" }] },
    { ...feedback, diagnostics: Array.from({ length: 21 }, () => diagnostic) },
    { ...feedback, page: { ...feedback.page, dpr: -1 } },
    { ...feedback, page: { ...feedback.page, url: "javascript:alert(1)" } },
    { ...feedback, page: { ...feedback.page, url: "https://other.test/w/alfa" } },
  ];
  const invalidStatuses = await Array.fromAsync(
    invalidBodies,
    async (invalid) => (await submit(ownerHeaders(), invalid)).status,
  );
  expect(invalidStatuses).toEqual(EffectArray.map(invalidBodies, () => 400));

  const raw = (body: RequestInit["body"], headers: Record<string, string> = {}) =>
    app.fetch("/api/feedback", {
      method: "POST",
      headers: { ...ownerHeaders(), "content-type": "application/json", ...headers },
      body,
    });
  expect((await raw("{bad json")).status).toBe(400);
  expect((await raw(json(feedback).body, { "content-type": "text/plain" })).status).toBe(400);
  expect((await raw("{}", { "content-length": "262145" })).status).toBe(413);
  expect((await raw(`"${EffectString.repeat(262_144)("a")}"`)).status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});

const issueFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    title: Schema.String,
    labels: Schema.Array(Schema.String),
    body: Schema.String,
  }),
);
const leakedUrlParts = /url-password|query-token|secret-fragment/;
const leakedPageParts = /private-(url|query|id|name|text)/;
const leakedLinks = /v1\.|private-query|private-invite/;

const upstreamRequest = () => {
  const call = upstream.mock.calls.at(-1);
  if (call === undefined) throw new Error("GitHub transport was not called");
  if (call[0] instanceof Request) return new Request(call[0], call[1]);
  return new Request(String(call[0]), call[1]);
};

test("submits one labeled issue with structured Markdown and no active user-supplied markup", async () => {
  const response = await submit(ownerHeaders());
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    issueNumber: 42,
    issueUrl: "https://github.com/example/kvitbit/issues/42",
    title: "Visual feedback: The button wraps",
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(analytics.capture.mock.calls).toEqual([
    [
      {
        event: "feedback_submitted",
        distinctId: owner.userId,
        properties: { hasPin: true },
      },
    ],
  ]);
  const outbound = upstreamRequest();
  expect(outbound.url).toBe("https://api.github.com/repos/example/kvitbit/issues");
  expect(outbound.method).toBe("POST");
  expect(outbound.redirect).toBe("error");
  expect(outbound.headers.get("authorization")).toBe(`Bearer ${token}`);
  const issue = issueFields(await outbound.json()).pipe(Effect.runSync);
  expect(issue.labels).toEqual(["visual-feedback"]);
  expect(issue.body).toContain(
    "~~~text\nThe button wraps\n```\n[@someone](https://untrusted.test)\n~~~",
  );
  expect(issue.body).toContain(`URL: "${ORIGIN}/w/alfa"`);
  expect(issue.body).toContain('Selector: "main > button:nth-of-type(1)"');
  expect(issue.body).toContain('Accessible name: "Send"');
  expect(issue.body).toContain("Rect: x=3.5, y=4, width=119, height=24");
  expect(issue.body).toContain('Font size: "14px"');
  expect(issue.body).toContain("- warn at 2023-11-14T22:13:20.000Z");
  expect(issue.body).not.toMatch(leakedUrlParts);
});

const encodedSlash = encodeURIComponent("/");
const twiceEncodedSlash = encodeURIComponent(encodedSlash);

test.each([
  "/i/private-url",
  "/s/private-url",
  "/invite/private-url",
  "/auth/verify/private-url",
  "/consent/private-url",
  "/oauth/consent/private-url",
  "/reset-password/private-url",
  "/api/v1/share/private-url",
  "/api/auth/magic-link/%76erify/private-url",
  `/app/%61uth${encodedSlash}callback${encodedSlash}private-url`,
  `/x/%252e%252e/app/%2569${twiceEncodedSlash}private-url`,
  "/app/w/alfa/settings/api%4Beys",
  "/w/alfa/settings/api-keys",
  "/[redacted]",
])("redacts the sensitive route %s and its automatic text", async (path) => {
  const response = await submit(ownerHeaders(), {
    ...feedback,
    page: { ...feedback.page, url: `${ORIGIN}${path}?token=private-query` },
    pins: [
      { ...pin, selector: "#private-id", accessibleName: "private-name", text: "private-text" },
    ],
  });
  expect(response.status).toBe(201);
  const issue = issueFields(await upstreamRequest().json()).pipe(Effect.runSync);
  expect(issue.body).toContain(`URL: "${ORIGIN}/[redacted]"`);
  expect(issue.body).toContain('Selector: ""');
  expect(issue.body).toContain('DOM path: "main > button:nth-of-type(1)"');
  expect(issue.body).not.toMatch(leakedPageParts);
});

test("removes workspace API keys from titles, comments and fields outside sensitive pages", async () => {
  const fixtureId = "00000000-0000-0000-0000-000000000000";
  const keyPrefix = `kvb_${fixtureId}`;
  const fakeKeyMaterial = "fake_test_secret_that_must_never_be_sent_123";
  const key = `${keyPrefix}_${fakeKeyMaterial}`;
  const response = await submit(ownerHeaders(), {
    ...feedback,
    comment: `Please check ${key}`,
    pins: [
      { ...pin, text: `Displayed ${keyPrefix}`, selector: `#${EffectString.slice(0, -22)(key)}` },
    ],
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ title: "Visual feedback: Please check redacted" });
  const issue = issueFields(await upstreamRequest().json()).pipe(Effect.runSync);
  expect(issue.body).toContain("Please check [redacted]");
  expect(issue.body).toContain('Selector: "#[redacted]"');
  expect(issue.body).toContain(`Text: "Displayed ${keyPrefix}"`);
  expect(issue.body).not.toContain(`${keyPrefix}_`);
});

test("removes embedded token-bearing links from the outgoing issue on an ordinary page", async () => {
  const shareUrl = `${ORIGIN}/i/v1.comment-secret?download=private-query`;
  const encoded = `${ORIGIN}/app/%2569%252Fv1.encoded-secret`;
  const encodedUrl = encodeURIComponent(`${ORIGIN}/i/v1.encoded-absolute-secret`);
  const relative = "/s/v1.relative-secret/pdf";
  const response = await submit(ownerHeaders(), {
    ...feedback,
    comment: `Check (${shareUrl})\nEncoded: ${encodedUrl}\nInvite: /invite/private-invite`,
    pins: [{ ...pin, text: `Copied ${encoded}`, accessibleName: relative }],
    page: { ...feedback.page, theme: "/api/v1/share/v1.theme-secret/logo" },
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ title: "Visual feedback: Check redacted" });
  const issue = issueFields(await upstreamRequest().json()).pipe(Effect.runSync);
  expect(issue.title).toBe("Visual feedback: Check redacted");
  expect(issue.body).toContain("Check ([redacted])");
  expect(issue.body).toContain("Encoded: [redacted]");
  expect(issue.body).toContain("Invite: [redacted]");
  expect(issue.body).toContain('Text: "Copied [redacted]"');
  expect(issue.body).toContain('Accessible name: "[redacted]"');
  expect(issue.body).toContain('Theme: "[redacted]"');
  expect(issue.body).toContain(`URL: "${ORIGIN}/w/alfa"`);
  expect(issue.body).not.toMatch(leakedLinks);
});

test("rate limits validated submissions per verified user before calling GitHub", async () => {
  const secondOwner = await sessionFor(secondOwnerEmail);
  expect((await submit(ownerHeaders(), { ...feedback, comment: " " })).status).toBe(400);
  const statuses = await Array.fromAsync(
    { length: 12 },
    async () => (await submit(ownerHeaders())).status,
  );
  expect(statuses).toEqual(Array.from({ length: 12 }, () => 201));
  const denied = await submit(ownerHeaders());
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("60");
  expect(upstream).toHaveBeenCalledTimes(12);
  expect((await submit({ origin: ORIGIN, cookie: secondOwner.cookie })).status).toBe(201);
  await app.run(TestClock.adjust("1 minute"));
  expect((await submit(ownerHeaders())).status).toBe(201);
  expect(upstream).toHaveBeenCalledTimes(14);
});

test("GitHub errors and invented issue URLs do not reach the caller", async () => {
  upstream
    .mockResolvedValueOnce(Response.json({ message: `Do not return ${token}` }, { status: 403 }))
    .mockRejectedValueOnce(new Error(`Do not return ${token}`))
    .mockResolvedValueOnce(
      Response.json({ number: -3, html_url: "https://other.test" }, { status: 201 }),
    )
    .mockResolvedValueOnce(
      Response.json({ number: 22, html_url: "https://other.test" }, { status: 201 }),
    );
  const failures = await Array.fromAsync({ length: 3 }, async () => {
    const response = await submit(ownerHeaders());
    return { status: response.status, body: await response.text() };
  });
  expect(failures).toEqual(Array.from({ length: 3 }, () => ({ status: 502, body: "" })));
  expect(await (await submit(ownerHeaders())).json()).toMatchObject({
    issueNumber: 22,
    issueUrl: "https://github.com/example/kvitbit/issues/22",
  });
});

test("absent or malformed configuration leaves feedback disabled", async () => {
  const redacted = Redacted.make(token);
  expect(makeFeedbackConfig(undefined, "example/kvitbit", ownerEmail)).toBeUndefined();
  expect(
    makeFeedbackConfig(Redacted.make("garbage"), "example/kvitbit", ownerEmail),
  ).toBeUndefined();
  expect(makeFeedbackConfig(redacted, "example/..", ownerEmail)).toBeUndefined();
  expect(
    makeFeedbackConfig(redacted, "https://github.com/example/kvitbit", ownerEmail),
  ).toBeUndefined();
  expect(makeFeedbackConfig(redacted, "example/kvitbit", "")).toBeUndefined();
  expect(makeFeedbackConfig(redacted, "example/kvitbit", `${ownerEmail},bad`)).toBeUndefined();
  expect(
    makeFeedbackConfig(
      redacted,
      "example/kvitbit",
      ` ${EffectString.toUpperCase(ownerEmail)} `,
    )?.ownerEmails.has(ownerEmail),
  ).toBe(true);

  const disabled = makeHarness();
  try {
    expect((await disabled.fetch("/api/feedback", { method: "POST" })).status).toBe(404);
  } finally {
    await disabled.dispose();
  }
});

test("accepts supported GitHub token formats and rejects incomplete configuration values", () => {
  const configFor = (value: string) =>
    makeFeedbackConfig(Redacted.make(value), "example/kvitbit", ownerEmail);
  const fineGrained = `github_pat_${EffectString.repeat(22)("x")}_${EffectString.repeat(59)("y")}`;
  for (const prefix of ["ghp", "gho", "ghu", "ghs"]) {
    expect(configFor(`${prefix}_${EffectString.repeat(36)("x")}`)).toBeDefined();
    expect(configFor(`${prefix}_${EffectString.repeat(35)("x")}`)).toBeUndefined();
  }
  expect(configFor(fineGrained)).toBeDefined();
  expect(configFor(EffectString.slice(0, -1)(fineGrained))).toBeUndefined();
  expect(configFor(token)).toBeDefined();
  expect(configFor(`ghs_12345_${EffectString.repeat(8192)("a")}.b.c`)).toBeUndefined();
  const lastSegment = EffectString.lastIndexOf(".")(token).pipe(Option.getOrThrow);
  expect(configFor(EffectString.slice(0, lastSegment)(token))).toBeUndefined();
  expect(configFor("ghp_X")).toBeUndefined();
  expect(configFor(`${token}\n`)).toBeUndefined();
});
