import { describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { NodeHttpServer } from "@effect/platform-node";
import { SESSION_COOKIE } from "@kvitbit/api-contract";
import { EmailSender } from "@kvitbit/domain/ports";
import { Cause, Effect, Layer, Logger, Option, Redacted, References } from "effect";
import {
  FetchHttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import { SqlClient } from "effect/sql";
import { SqlError, UniqueViolation } from "effect/sql/SqlError";
import { RequestIdsLive, withRequestLogging } from "../../src/http/edge/requestId";
import { makeServerLogger, selectLogFormat } from "../../src/logging/logger";
import { parseCloudTrace, RequestLogContext } from "../../src/logging/trace";
import { makeEmailSenderLayer, parseSmtpUrl } from "../../src/wiring/email";
import { makeHarness, ORIGIN } from "../http/harness";

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
  const layer = Logger.layer([makeServerLogger(format, projectId, (line) => lines.push(line))]);
  return { lines, layer };
};

const entries = (lines: ReadonlyArray<string>) =>
  lines.map((line) => {
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
    return JSON.parse(line) as Record<string, unknown>;
  });

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
    expect(logs.map((line) => line.severity)).toEqual([
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
      expect(typeof timestamp).toBe("string");
      expect(new Date(String(timestamp)).toISOString()).toBe(String(timestamp));
    }
  });

  test("parses Cloud Trace IDs, optional sampling and unsigned decimal span IDs", () => {
    expect(parseCloudTrace(traceHeader)).toEqual({
      traceId,
      spanId: "000000000000004a",
      sampled: false,
    });
    expect(parseCloudTrace(`${traceId.toUpperCase()}/18446744073709551615;o=1`)).toEqual({
      traceId,
      spanId: "ffffffffffffffff",
      sampled: true,
    });
    expect(parseCloudTrace(traceId)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId};o=1`)).toEqual({ traceId, sampled: true });
    expect(parseCloudTrace(`${traceId}/18446744073709551616`)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId}/0`)).toEqual({ traceId });
    expect(parseCloudTrace(`${traceId}/1;o=2`)).toBeUndefined();
    expect(parseCloudTrace(`${"0".repeat(32)}/1`)).toBeUndefined();
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
    expect(second?.annotations).not.toHaveProperty("requestId");
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
      middleware: (handle) => withRequestLogging(HttpMiddleware.logger(handle)),
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })));
    await Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* Layer.build(server);
        yield* HttpServer.addressFormattedWith((address) =>
          Effect.promise(async () => {
            await fetch(`${address}/s/private-share-token`, { headers });
            const unmatched = await fetch(`${address}/missing/private-without-known-route`, {
              headers,
            });
            expect(unmatched.status).toBe(404);
          }),
        ).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    const logs = entries(lines);
    expect(logs.find(({ message }) => message === "Ran handler")).toMatchObject(correlation);
    expect(logs.find(({ message }) => message === "Sent HTTP response")).toMatchObject({
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
    expect(lines.join("")).not.toContain("private-share-token");
    expect(lines.join("")).not.toContain("private-without-known-route");
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
        serialized: JSON.stringify(JSON.stringify({ password: "private-escaped-password" })),
        callback: "/auth/magic/private-magic-callback",
        consent: "/api/v1/oauth/consents/private-consent",
        state: "/sign-in?state=private-oauth-state",
        stdoutError: { response: "private-smtp-response" },
      },
      cause: new Error(`nested ${magicLink}`),
      databaseError: new SqlError({
        reason: new UniqueViolation({
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
    const bareToken = "t".repeat(43);
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
      const output = lines.join("");
      expect(output).not.toMatch(
        /private-|dXNlcjpwYXNz|kvb_privatecredential|should never evaluate/,
      );
      expect(output).not.toContain(bareToken);
      expect(output).toContain("[Circular]");
      expect(output).toContain("Unable to open [REDACTED]");
      expect(output).toContain('"42"');
      expect(output).toContain("statistic");
      expect(output).toContain("smtp.example.test");
      expect(output).toContain("UniqueViolation");
      if (format === "json") expect(entries(lines)[0]).toMatchObject({ severity: "ERROR" });
      else expect(output).toMatch(/^\[\d{4}-\d\d-\d\dT.+\] ERROR /);
    }
  });

  test("escapes terminal controls and keeps oversized JSON entries valid", () => {
    const pretty = capture(undefined, "pretty");
    Effect.runSync(Effect.logInfo("Hello\u001b[2J\nworld").pipe(Effect.provide(pretty.layer)));
    expect(pretty.lines[0]).toContain("Hello\\u001b[2J\\u000aworld");

    const json = capture();
    Effect.runSync(
      Effect.logError("Large metadata", {
        first: "x".repeat(140000),
        second: "y".repeat(140000),
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
    const logger = makeServerLogger("json", undefined, () => {
      throw new Error("sink failure");
    });
    expect(() =>
      Effect.runSync(
        Effect.logError("failed", hostile).pipe(Effect.provide(Logger.layer([logger]))),
      ),
    ).not.toThrow();
  });

  test("logs an unconfigured invitation send without envelope data and preserves EmailRejected", () => {
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
    const result = Effect.runSync(
      send.pipe(Effect.provide(unconfiguredEmail), Effect.provide(layer), Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EmailRejected", cause: "Email delivery is not configured" },
    });
    expect(entries(lines)).toMatchObject([
      {
        severity: "ERROR",
        message: "Email delivery rejected",
        annotations: {
          event: "EmailRejected",
          emailKind: "invitation",
          reason: "Email delivery is not configured",
        },
      },
    ]);
    expect(lines.join("")).not.toMatch(/private-|@example\.test/);

    const dev = capture();
    const developmentEmail = makeEmailSenderLayer(
      { from: "noreply@kvitbit.test", resendApiKey: Option.none(), smtpUrl: Option.none() },
      "development",
    );
    expect(
      Effect.runSync(send.pipe(Effect.provide(developmentEmail), Effect.provide(dev.layer))),
    ).toMatchObject({ provider: "console" });
    expect(entries(dev.lines)).toMatchObject([
      { severity: "INFO", message: "Email (not sent)", annotations: { emailKind: "invitation" } },
    ]);
    expect(dev.lines.join("")).not.toMatch(/private-|@example\.test/);
  });

  test("logs rejected verification, reset and magic-link deliveries through actual Better Auth routes", async () => {
    const { lines, layer } = capture("example-project");
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const app = makeHarness({ authEmailSender: unconfiguredEmail, logger: layer });
    const email = "private-identity@example.test";
    const password = "A private-strong password!";
    const post = (path: string, body: object) =>
      app.fetch(`/api/auth${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
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
        ["verification", "password-reset", "magic-link"].map((emailKind) => ({
          ...correlation,
          severity: "ERROR",
          annotations: {
            event: "EmailRejected",
            emailKind,
            reason: "Email delivery is not configured",
          },
        })),
      );
      expect(lines.join("")).not.toMatch(/private-|token=|\/reset-password\/|\/magic-link\/verify/);
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
        preconnect: () => {},
      },
    );
    const authEmailSender = makeEmailSenderLayer(
      {
        from: "noreply@kvitbit.test",
        resendApiKey: Option.some(Redacted.make("private-resend-key")),
        smtpUrl: Option.none(),
      },
      "production",
    ).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, send)));
    const app = makeHarness({ authEmailSender, logger: layer });
    const email = "private-configured-recipient@example.test";
    const password = "A private-strong password!";
    const post = (path: string, body: object, cookie?: string) =>
      app.fetch(`/api/auth${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          origin: ORIGIN,
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      });
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
      const cookie = login.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
        ?.split(";")[0];
      expect(cookie).toBeDefined();
      expect(
        (await post("/change-email", { newEmail: "private-new-email@example.test" }, cookie))
          .status,
      ).toBe(200);

      expect(entries(lines)).toMatchObject(
        ["verification", "change-email"].map((emailKind) => ({
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
      expect(lines.join("")).not.toContain("private-");
    } finally {
      await app.dispose();
    }
  }, 30000);

  test("uses the first configured Cloud project environment variable", () => {
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
      const result = Bun.spawnSync({
        cmd: [process.execPath, "-e", program],
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { NODE_ENV: "production", ...Object.fromEntries(aliases.slice(index)) },
      });
      expect(result.exitCode).toBe(0);
      expect(entries([result.stdout.toString()])).toMatchObject([
        { "logging.googleapis.com/trace": `projects/${project}/traces/${traceId}` },
      ]);
    }
  }, 30000);

  for (const entry of ["main", "worker", "migrate"]) {
    test(`${entry} fails invalid LOG_FORMAT with a single safe JSON diagnostic on stdout`, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, fileURLToPath(new URL(`../../src/${entry}.ts`, import.meta.url))],
        env: { NODE_ENV: "production", LOG_FORMAT: "private-invalid-format" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toBe("");
      const stdout = result.stdout.toString();
      expect(entries([stdout])).toMatchObject([
        { severity: "ERROR", message: "Server process failed" },
      ]);
      expect(stdout).toContain("LOG_FORMAT must be json or pretty");
      expect(stdout).not.toContain("private-invalid-format");
    }, 30000);
  }

  test("drains large stdout entries before a failed process exits", () => {
    const program = `
      import { Effect } from "effect";
      import { runServerMain } from "./src/logging/logger";
      runServerMain(Effect.logInfo("x".repeat(150000)).pipe(
        Effect.andThen(Effect.fail(new Error("synthetic failure"))),
      ));
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", program],
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { NODE_ENV: "production" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    const stdout = result.stdout.toString();
    const [first, last] = entries(
      stdout
        .trimEnd()
        .split("\n")
        .map((line) => `${line}\n`),
    );
    expect(first?.message).toBe("x".repeat(150000));
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
