import { describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SESSION_COOKIE } from "@kvitbit/api-contract";
import { EmailSender } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { RequestIdsLive, withRequestLogging } from "../../src/http/edge/requestId";
import { makeServerLogger, selectLogFormat } from "../../src/logging/logger";
import { parseCloudTrace, RequestLogContext } from "../../src/logging/trace";
import { makeEmailSenderLayer, parseSmtpUrl } from "../../src/wiring/email";
import { makeHarness, ORIGIN } from "../http/harness";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const entriesPattern = /[\r\n]/;
const privateDxnlcjpwyxnzKvbPattern =
  /private-|dXNlcjpwYXNz|kvb_privatecredential|should never evaluate/;
const errorPattern = /^\[\d{4}-\d\d-\d\dT.+\] ERROR /;
const privateExampleTestPattern = /private-|@example\.test/;
const privateTokenResetPattern = /private-|token=|\/reset-password\/|\/magic-link\/verify/;

const traceId = "105445aa7843bc8bf206b12000100000";
const traceHeader = `${traceId}/74;o=0`;
const requestId = "01900000-0000-7000-8000-000000000001";
const headers = { "x-cloud-trace-context": traceHeader, "x-request-id": requestId };
const correlation = {
  "logging.googleapis.com/trace": `projects/example-project/traces/${traceId}`,
  "logging.googleapis.com/spanId": "000000000000004a",
  "logging.googleapis.com/trace_sampled": false,
  requestId,
};

const capture = (projectId?: string, format: "json" | "pretty" = "json") => {
  const lines: Array<string> = [];
  const layer = Logger.layer([
    makeServerLogger({ format, projectId, write: (line) => lines.push(line) }),
  ]);
  return { lines, layer };
};

const entries = (lines: ReadonlyArray<string>) =>
  Arr.map(lines, (line) => {
    if (!Str.endsWith("\n")(line) || entriesPattern.test(Str.slice(0, -1)(line))) {
      throw new Error("Expected one complete JSON log entry per line");
    }
    return Schema.decodeResult(Schema.fromJsonString(Schema.JsonObject))(line).pipe(
      Result.getOrThrow,
    );
  });

const runLoggerFixture = async (options: {
  readonly cmd: string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
}) => {
  const child = Bun.spawn({ ...options, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const failingProdEmail = (status = 422, body = "private-provider-payload") => {
  const send = Object.assign(async () => new Response(body, { status }), {
    preconnect: () => undefined,
  });
  return makeEmailSenderLayer(
    {
      from: "noreply@kvitbit.test",
      resendApiKey: Option.some(Redacted.make("private-resend-key")),
      smtpUrl: Option.none(),
    },
    "production",
  ).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, send)), Layer.orDie);
};

const unconfiguredEmail = makeEmailSenderLayer(
  { from: "noreply@kvitbit.test", resendApiKey: Option.none(), smtpUrl: Option.none() },
  "production",
);

describe("server logging", () => {
  test("selects a format from the override, environment and stdout TTY", () => {
    expect(selectLogFormat(undefined, "development", true)).toBe("pretty");
    expect(selectLogFormat(undefined, "production", true)).toBe("json");
    expect(selectLogFormat(undefined, "development", false)).toBe("json");
    expect(selectLogFormat(undefined, undefined, undefined)).toBe("json");
    expect(selectLogFormat("JsOn", "development", true)).toBe("json");
    expect(selectLogFormat("PrEtTy", "production", false)).toBe("pretty");
    expect(() => selectLogFormat("unexpected", "development", true)).toThrow(
      "LOG_FORMAT must be json or pretty",
    );
  });

  test("writes one JSON line per message at the Cloud Logging severity for each Effect level", () => {
    const { lines, layer } = capture();
    const log = Effect.gen(function* () {
      yield* Effect.log("first\nsecond").pipe(
        Effect.provideService(References.CurrentLogLevel, "All"),
      );
      yield* Effect.logTrace("trace");
      yield* Effect.logDebug("debug");
      yield* Effect.logInfo("info");
      yield* Effect.logWarning("warning");
      yield* Effect.logError("error");
      yield* Effect.logFatal("fatal");
      yield* Effect.log("none").pipe(Effect.provideService(References.CurrentLogLevel, "None"));
    });
    Effect.runSync(
      log.pipe(Effect.provideService(References.MinimumLogLevel, "All"), Effect.provide(layer)),
    );

    const logs = entries(lines);
    expect(Arr.map(logs, (line) => line["severity"])).toEqual([
      "DEBUG",
      "DEBUG",
      "DEBUG",
      "INFO",
      "WARNING",
      "ERROR",
      "CRITICAL",
      "DEFAULT",
    ]);
    expect(logs[0]).toMatchObject({ message: "first\nsecond", annotations: {}, spans: {} });
    for (const { timestamp } of logs) {
      expect(Predicate.isString(timestamp)).toBe(true);
      expect(DateTime.toDateUtc(DateTime.makeUnsafe(String(timestamp))).toISOString()).toBe(
        String(timestamp),
      );
    }
  });

  test("parses Cloud Trace IDs, optional sampling and unsigned decimal span IDs", () => {
    expect(parseCloudTrace(traceHeader)).toEqual({
      traceId,
      spanId: "000000000000004a",
      sampled: false,
    });
    expect(parseCloudTrace(`${Str.toUpperCase(traceId)}/18446744073709551615;o=1`)).toEqual({
      traceId,
      spanId: "ffffffffffffffff",
      sampled: true,
    });
    expect(parseCloudTrace(traceId)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId};o=1`)).toEqual({ traceId, sampled: true });
    expect(parseCloudTrace(`${traceId}/18446744073709551616`)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId}/0`)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId}/1;o=2`)).toBeUndefined();
    expect(parseCloudTrace(`${Str.repeat(32)("0")}/1`)).toBeUndefined();
    expect(parseCloudTrace("invalid")).toBeUndefined();
  });

  test("retains traceId without a GCP project and promotes request annotations", () => {
    const { lines, layer } = capture();
    Effect.runSync(
      Effect.log("request").pipe(
        Effect.provideService(RequestLogContext, {
          trace: parseCloudTrace(traceHeader),
          requestId,
        }),
        Effect.andThen(
          Effect.log("annotation").pipe(Effect.annotateLogs({ requestId, result: "ok" })),
        ),
        Effect.provide(layer),
      ),
    );
    const [first, second] = entries(lines);
    expect(first).toMatchObject({ traceId, requestId });
    expect(first).not.toHaveProperty("logging.googleapis.com/trace");
    expect(second).toMatchObject({ requestId, annotations: { result: "ok" } });
    expect(second?.["annotations"]).not.toHaveProperty("requestId");
  });

  test("keeps Node HTTP handler and response logs in the same request context", async () => {
    const { lines, layer } = capture("example-project");
    const routes = Layer.merge(
      RequestIdsLive,
      HttpRouter.use((router) =>
        router.add(
          "GET",
          "/s/:token",
          Effect.log("Ran handler").pipe(Effect.as(HttpServerResponse.empty())),
        ),
      ),
    );
    const server = HttpRouter.serve(routes, {
      disableLogger: true,
      disableListenLog: true,
      middleware: (handle) => handle.pipe(HttpMiddleware.logger, withRequestLogging),
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })));
    await Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* Layer.build(Layer.merge(server, FetchHttpClient.layer));
        yield* HttpServer.addressFormattedWith(
          Effect.fnUntraced(function* (address) {
            yield* HttpClient.get(`${address}/s/private-share-token`, { headers });
            const unmatched = yield* HttpClient.get(
              `${address}/missing/private-without-known-route`,
              { headers },
            );
            expect(unmatched.status).toBe(404);
          }),
        ).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    const logs = entries(lines);
    Arr.findFirst(logs, ({ message }) => message === "Ran handler")
      .pipe(Option.getOrUndefined, expect)
      .toMatchObject(correlation);
    Arr.findFirst(logs, ({ message }) => message === "Sent HTTP response")
      .pipe(Option.getOrUndefined, expect)
      .toMatchObject({
        ...correlation,
        annotations: { "http.route": "/s/:token" },
      });
    expect(logs).toContainEqual(
      expect.objectContaining({
        ...correlation,
        annotations: expect.objectContaining({ "http.route": "<unmatched>" }),
        cause: [{ type: "Fail", error: { type: "HttpServerError", reason: "RouteNotFound" } }],
      }),
    );
    expect(Arr.join(lines, "")).not.toContain("private-share-token");
    expect(Arr.join(lines, "")).not.toContain("private-without-known-route");
  });

  test("redacts raw and encoded secrets in both formats, including errors and nested metadata", () => {
    const database = "postgresql://db-user:private-db-password@localhost/db";
    const verification = "https://kvitbit.test/api/auth/verify-email?token=private-verification";
    const reset = "https://kvitbit.test/api/auth/reset-password/private-reset?callbackURL=%2F";
    const magicLink = "https://kvitbit.test/api/auth/magic-link/verify?token=private-magic";
    const invite = "/invite/private-invitation";
    const defects = {
      passwords: { password: "private-password" },
      bigint: 42n,
      nested: {
        DATABASE_URL_UNPOOLED: database,
        apiKey: "private-api-key",
        sessionToken: Redacted.make("private-session"),
        encoded: encodeURIComponent(verification),
        invitationUrl: invite,
        reset,
        "api%4Bey": "private-encoded-key",
        parsedSmtp: parseSmtpUrl("smtp://user:private-smtp-pass@smtp.example.test"),
        flatSmtpDiagnostic: "transport.auth.pass=private-flat-smtp-pass",
        serialized: encodeJson(encodeJson({ password: "private-escaped-password" })),
        callback: "/auth/magic/private-magic-callback",
        consent: "/api/v1/oauth/consents/private-consent",
        state: "/sign-in?state=private-oauth-state",
        stdoutError: { response: "private-smtp-response" },
      },
      cause: new Error(`nested ${magicLink}`),
      databaseError: SqlError.SqlError.make({
        reason: SqlError.UniqueViolation.make({
          message: "Key (token)=(private-sql) already exists",
          cause: new Error("private-driver-error"),
          constraint: "auth_unique_token",
        }),
      }),
    };
    const error = new Error(`Unable to open ${database}`, { cause: defects });
    const cyclic = { error, back: error };
    Object.assign(error, { cyclic });
    Object.defineProperty(error, "throwingGetter", {
      enumerable: true,
      get: () => {
        throw new Error("should never evaluate logging getters");
      },
    });
    const bareToken = Str.repeat(43)("t");
    const log = Effect.logError(
      "Bearer private-bearer:token and Basic dXNlcjpwYXNz",
      {
        secret: "private-secret",
        other: "kvb_privatecredential",
        jar: "Cookie: sid=private-cookie",
        share: `v1.${bareToken}`,
        invitation: bareToken,
      },
      Cause.die(error),
    ).pipe(
      Effect.annotateLogs({
        link: new URL(verification),
        statistic: 7n,
        auth: "Authorization: private-auth",
      }),
      Effect.withLogSpan("open /s/private-share/pdf"),
    );

    for (const format of ["json", "pretty"] as const) {
      const { lines, layer } = capture(undefined, format);
      Effect.runSync(log.pipe(Effect.provide(layer)));
      const output = Arr.join(lines, "");
      expect(output).not.toMatch(privateDxnlcjpwyxnzKvbPattern);
      expect(output).not.toContain(bareToken);
      expect(output).toContain("[Circular]");
      expect(output).toContain("Unable to open [REDACTED]");
      expect(output).toContain('"42"');
      expect(output).toContain("statistic");
      expect(output).toContain("smtp.example.test");
      expect(output).toContain("UniqueViolation");
      const severity =
        format === "json"
          ? entries(lines)[0]?.["severity"]
          : errorPattern.test(output)
            ? "ERROR"
            : undefined;
      expect(severity).toBe("ERROR");
    }
  });

  test("escapes terminal controls and keeps oversized JSON entries valid", () => {
    const pretty = capture(undefined, "pretty");
    Effect.runSync(Effect.logInfo("Hello\u001b[2J\nworld").pipe(Effect.provide(pretty.layer)));
    expect(pretty.lines[0]).toContain("Hello\\u001b[2J\\u000aworld");

    const json = capture();
    Effect.runSync(
      Effect.logError("Large metadata", {
        first: Str.repeat(140000)("x"),
        second: Str.repeat(140000)("y"),
      }).pipe(Effect.provide(json.layer)),
    );
    expect(entries(json.lines)).toMatchObject([
      { severity: "ERROR", message: "Log entry exceeded the size limit" },
    ]);
  });

  test("never fails the logging fiber when a value or sink throws", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("descriptor failure");
        },
      },
    );
    const logger = makeServerLogger({
      format: "json",
      write: () => {
        throw new Error("sink failure");
      },
    });
    expect(() =>
      Effect.runSync(
        Effect.logError("failed", hostile).pipe(Effect.provide(Logger.layer([logger]))),
      ),
    ).not.toThrow();
  });

  test("fails fast for unconfigured production email, logs rejected invitation sends without envelope data, and logs console dev sends safely", async () => {
    const unconfiguredExit = await Layer.build(unconfiguredEmail).pipe(
      Effect.scoped,
      Effect.runPromiseExit,
    );
    expect(unconfiguredExit._tag).toBe("Failure");

    const { lines, layer } = capture();
    const send = Effect.flatMap(EmailSender, (sender) =>
      sender.send(
        {
          to: ["recipient@example.test"],
          replyTo: "sender@example.test",
          subject: "/invite/private-invite",
          html: "<a href='/invite/private-invite'>Accept</a>",
          text: "/invite/private-invite",
          attachments: [],
          tags: { template: "E04", token: "private-tag" },
        },
        { idempotencyKey: "private-idempotency-key" },
      ),
    );
    const result = await Effect.runPromise(
      send.pipe(Effect.provide(failingProdEmail().pipe(Layer.provideMerge(layer))), Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EmailRejected" },
    });
    expect(entries(lines)).toMatchObject([
      {
        severity: "ERROR",
        message: "Email delivery rejected",
        annotations: {
          event: "EmailRejected",
          emailKind: "invitation",
          reason: "Email provider failed to deliver",
        },
      },
    ]);
    expect(Arr.join(lines, "")).not.toMatch(privateExampleTestPattern);

    const dev = capture();
    const developmentEmail = makeEmailSenderLayer(
      { from: "noreply@kvitbit.test", resendApiKey: Option.none(), smtpUrl: Option.none() },
      "development",
    );
    send
      .pipe(
        Effect.provide(developmentEmail.pipe(Layer.provideMerge(dev.layer))),
        Effect.runSync,
        expect,
      )
      .toMatchObject({ provider: "console" });
    expect(entries(dev.lines)).toMatchObject([
      { severity: "INFO", message: "Email (not sent)", annotations: { emailKind: "invitation" } },
    ]);
    expect(Arr.join(dev.lines, "")).not.toMatch(privateExampleTestPattern);
  });

  test("logs rejected verification, reset and magic-link deliveries through actual Better Auth routes", async () => {
    const { lines, layer } = capture("example-project");
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const app = makeHarness({ authEmailSender: failingProdEmail(), logger: layer });
    const email = "private-identity@example.test";
    const password = "A private-strong password!";
    const post = (path: string, body: Schema.JsonObject) =>
      app.fetch(`/api/auth${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", origin: ORIGIN },
        body: encodeJson(body),
      });
    try {
      expect((await post("/sign-up/email", { email, password, name: "Test Person" })).status).toBe(
        200,
      );
      expect(
        (await post("/request-password-reset", { email, redirectTo: "/reset-password" })).status,
      ).toBe(200);
      expect((await post("/sign-in/magic-link", { email, callbackURL: "/sign-in" })).status).toBe(
        500,
      );

      const logs = entries(lines);
      expect(logs).toMatchObject(
        Arr.map(["verification", "password-reset", "magic-link"], (emailKind) => ({
          ...correlation,
          severity: "ERROR",
          annotations: {
            event: "EmailRejected",
            emailKind,
            reason: "Email provider failed to deliver",
          },
        })),
      );
      expect(Arr.join(lines, "")).not.toMatch(privateTokenResetPattern);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await app.dispose();
    }
  }, 30000);

  test("logs configured provider failures that Better Auth handles internally", async () => {
    const { lines, layer } = capture("example-project");
    const send = Object.assign(
      async () => new Response("private-provider-payload", { status: 422 }),
      {
        preconnect: () => undefined,
      },
    );
    const authEmailSender = makeEmailSenderLayer(
      {
        from: "noreply@kvitbit.test",
        resendApiKey: Option.some(Redacted.make("private-resend-key")),
        smtpUrl: Option.none(),
      },
      "production",
    ).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, send)), Layer.orDie);
    const app = makeHarness({ authEmailSender, logger: layer });
    const email = "private-configured-recipient@example.test";
    const password = "A private-strong password!";
    const post = (path: string, body: Schema.JsonObject, cookie?: string) => {
      const cookieHeader = cookie === undefined ? {} : { cookie };
      return app.fetch(`/api/auth${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          origin: ORIGIN,
          ...cookieHeader,
        },
        body: encodeJson(body),
      });
    };
    try {
      expect((await post("/sign-up/email", { email, password, name: "Test Person" })).status).toBe(
        200,
      );
      await app.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`update auth."user" set email_verified = true where email = ${email}`;
        }),
      );
      const login = await post("/sign-in/email", { email, password });
      expect(login.status).toBe(200);
      const cookie = Arr.findFirst(login.headers.getSetCookie(), (value) =>
        Str.startsWith(`${SESSION_COOKIE}=`)(value),
      ).pipe(
        Option.map((value) => Str.split(value, ";")[0]),
        Option.getOrUndefined,
      );
      expect(cookie).toBeDefined();
      expect(
        (await post("/change-email", { newEmail: "private-new-email@example.test" }, cookie))
          .status,
      ).toBe(200);

      expect(entries(lines)).toMatchObject(
        Arr.map(["verification", "change-email"], (emailKind) => ({
          ...correlation,
          severity: "ERROR",
          message: "Email delivery rejected",
          annotations: {
            emailKind,
            event: "EmailRejected",
            reason: "Email provider failed to deliver",
          },
        })),
      );
      expect(Arr.join(lines, "")).not.toContain("private-");
    } finally {
      await app.dispose();
    }
  }, 30000);

  test("uses the first configured Cloud project environment variable", async () => {
    const program = `
      import { Effect } from "effect";
      import { runServerMain } from "./src/logging/logger";
      import { parseCloudTrace, RequestLogContext } from "./src/logging/trace";
      runServerMain(Effect.logInfo("correlated").pipe(Effect.provideService(RequestLogContext, {
        requestId: "${requestId}", trace: parseCloudTrace("${traceHeader}"),
      })));
    `;
    const aliases = [
      ["GOOGLE_CLOUD_PROJECT", "google-cloud-project"],
      ["GCP_PROJECT", "gcp-project"],
      ["KVITBIT_GCP_PROJECT_ID", "kvitbit-gcp-project"],
      ["KVITBIT_GCS_PROJECT", "kvitbit-gcs-project"],
    ] as const;
    for (const [index, [, project]] of aliases.entries()) {
      const result = await runLoggerFixture({
        cmd: [process.execPath, "-e", program],
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { NODE_ENV: "production", ...EffectRecord.fromEntries(aliases.slice(index)) },
      });
      expect(result.exitCode).toBe(0);
      expect(entries([result.stdout])).toMatchObject([
        { "logging.googleapis.com/trace": `projects/${project}/traces/${traceId}` },
      ]);
    }
  }, 30000);

  for (const entry of ["main", "worker", "migrate"]) {
    test(`${entry} fails invalid LOG_FORMAT with a single safe JSON diagnostic on stdout`, async () => {
      const result = await runLoggerFixture({
        cmd: [process.execPath, fileURLToPath(new URL(`../../src/${entry}.ts`, import.meta.url))],
        env: { NODE_ENV: "production", LOG_FORMAT: "private-invalid-format" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const stdout = result.stdout;
      expect(entries([stdout])).toMatchObject([
        { severity: "ERROR", message: "Server process failed" },
      ]);
      expect(stdout).toContain("LOG_FORMAT must be json or pretty");
      expect(stdout).not.toContain("private-invalid-format");
    }, 30000);
  }

  test("drains large stdout entries before a failed process exits", async () => {
    const program = `
      import { Effect } from "effect";
      import { runServerMain } from "./src/logging/logger";
      runServerMain(Effect.logInfo("x".repeat(150000)).pipe(
        Effect.andThen(Effect.fail(new Error("synthetic failure"))),
      ));
    `;
    const result = await runLoggerFixture({
      cmd: [process.execPath, "-e", program],
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { NODE_ENV: "production" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const stdout = result.stdout;
    const [first, last] = entries(
      Arr.map(Str.split(Str.trimEnd(stdout), "\n"), (line) => `${line}\n`),
    );
    expect(first?.["message"]).toBe(Str.repeat(150000)("x"));
    expect(last).toMatchObject({ severity: "ERROR", message: "Server process failed" });
  }, 30000);

  test("a closed stdout pipe does not fail the running server program", async () => {
    const program = `
      import { Effect } from "effect";
      import { runServerMain } from "./src/logging/logger";
      await Bun.stdin.text();
      runServerMain(Effect.logInfo("x".repeat(150000)).pipe(
        Effect.andThen(Effect.sleep("10 millis")),
        Effect.andThen(Effect.logInfo("after pipe failure")),
        Effect.andThen(Effect.sync(() => process.stderr.write("program completed\\n"))),
      ));
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", program],
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { NODE_ENV: "production" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.stdout.cancel();
    child.stdin.end();
    expect(await new Response(child.stderr).text()).toBe("program completed\n");
    expect(await child.exited).toBe(0);
  }, 30000);
});
