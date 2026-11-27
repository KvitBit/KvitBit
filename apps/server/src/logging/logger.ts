import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Logger, type LogLevel, References, Runtime } from "effect";
import { redactLogText, sanitizeLogValue } from "./redact";
import { RequestLogContext } from "./trace";

type LogFormat = "json" | "pretty";
const MAX_JSON_BYTES = 200 * 1024;
const escapeControl = (value: string): string =>
  `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`;

export const selectLogFormat = (
  explicit: string | undefined,
  nodeEnv: string | undefined,
  isTTY: boolean | undefined,
): LogFormat => {
  const format = explicit?.toLowerCase();
  if (format === "json" || format === "pretty") return format;
  if (format !== undefined) throw new Error("LOG_FORMAT must be json or pretty");
  return isTTY && nodeEnv !== "production" ? "pretty" : "json";
};

const cloudSeverity = {
  All: "DEBUG",
  Trace: "DEBUG",
  Debug: "DEBUG",
  Info: "INFO",
  Warn: "WARNING",
  Error: "ERROR",
  Fatal: "CRITICAL",
  None: "DEFAULT",
} as const satisfies Record<LogLevel.LogLevel, string>;

let pendingStdoutWrites = 0;
let onStdoutDrained: (() => void) | undefined;
let stdoutFailed = false;
let watchingStdout = false;

const failStdout = (): void => {
  stdoutFailed = true;
  pendingStdoutWrites = 0;
  onStdoutDrained?.();
};

const writeStdout = (line: string): void => {
  if (stdoutFailed) return;
  const stdout = process.stdout;
  if (!watchingStdout) {
    stdout.on("error", failStdout);
    watchingStdout = true;
  }
  pendingStdoutWrites++;
  let settled = false;
  const done = (error?: Error | null) => {
    if (settled) return;
    settled = true;
    if (error) {
      failStdout();
    } else if (!stdoutFailed && --pendingStdoutWrites === 0) {
      onStdoutDrained?.();
    }
  };
  try {
    stdout.write(line, done);
  } catch {
    failStdout();
  }
};

export const makeServerLogger = (
  format: LogFormat,
  projectId?: string,
  write: (line: string) => void = writeStdout,
) =>
  Logger.make(({ cause, date, fiber, logLevel, message }) => {
    const severity = cloudSeverity[logLevel];
    try {
      const timestamp = date.toISOString();
      const {
        requestId,
        "http.url": rawRequestPath,
        ...annotations
      } = fiber.getRef(References.CurrentLogAnnotations);
      const correlation = fiber.getRef(RequestLogContext);
      const route =
        rawRequestPath === undefined ? undefined : (correlation?.route ?? "<unmatched>");
      const annotated = sanitizeLogValue(annotations);
      const trace = correlation?.trace;
      const id = correlation?.requestId ?? requestId;
      const spans = Object.fromEntries(
        fiber.getRef(References.CurrentLogSpans).map(([label, start]) => [label, +date - start]),
      );
      const [first, ...details] = Array.isArray(message) ? message : [message];
      const headline = {
        severity,
        message:
          typeof first === "string"
            ? redactLogText(first)
            : first === undefined
              ? "Effect log"
              : typeof first === "object"
                ? JSON.stringify(sanitizeLogValue(first))
                : String(sanitizeLogValue(first)),
        timestamp,
        ...(typeof id === "string" ? { requestId: redactLogText(id) } : {}),
        ...(trace && projectId
          ? { "logging.googleapis.com/trace": `projects/${projectId}/traces/${trace.traceId}` }
          : trace
            ? { traceId: trace.traceId }
            : {}),
        ...(trace?.spanId === undefined ? {} : { "logging.googleapis.com/spanId": trace.spanId }),
        ...(trace?.sampled === undefined
          ? {}
          : { "logging.googleapis.com/trace_sampled": trace.sampled }),
      };
      const entry = {
        ...headline,
        annotations:
          route === undefined
            ? annotated
            : {
                ...(annotated !== null && typeof annotated === "object" && !Array.isArray(annotated)
                  ? annotated
                  : {}),
                "http.route": route,
              },
        spans: sanitizeLogValue(spans),
        ...(details.length > 0 ? { details: sanitizeLogValue(details) } : {}),
        ...(cause.reasons.length > 0 ? { cause: sanitizeLogValue(cause) } : {}),
      };
      if (format === "json") {
        const serialized = JSON.stringify(entry);
        write(
          `${
            Buffer.byteLength(serialized) <= MAX_JSON_BYTES
              ? serialized
              : JSON.stringify({ ...headline, message: "Log entry exceeded the size limit" })
          }\n`,
        );
      } else {
        const {
          message,
          timestamp,
          severity,
          annotations: fields,
          spans: timings,
          ...metadata
        } = entry;
        const context = {
          ...metadata,
          ...(Object.keys(annotations).length > 0 ? { annotations: fields } : {}),
          ...(Object.keys(spans).length > 0 ? { spans: timings } : {}),
        };
        const expanded =
          Object.keys(context).length > 0
            ? `\n${JSON.stringify(context, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/g, escapeControl)}`
            : "";
        write(
          `[${timestamp}] ${severity} ${message.replace(/[\p{Cc}\u2028\u2029]/gu, escapeControl)}${expanded}\n`,
        );
      }
    } catch {
      // Formatting or sink failures must never fail the Effect that is logging.
      try {
        const timestamp = new Date().toISOString();
        const message = "Unable to write log details";
        write(
          format === "json"
            ? `${JSON.stringify({ severity, timestamp, message })}\n`
            : `[${timestamp}] ${severity} ${message}\n`,
        );
      } catch {
        // The output stream is unavailable.
      }
    }
  });

const withServerLogging = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    const env = process.env;
    const projectId = [
      env.GOOGLE_CLOUD_PROJECT,
      env.GCP_PROJECT,
      env.KVITBIT_GCP_PROJECT_ID,
      env.KVITBIT_GCS_PROJECT,
    ]
      .map((value) => value?.trim())
      .find(Boolean);
    const format = Effect.try({
      try: () => selectLogFormat(env.LOG_FORMAT, env.NODE_ENV, process.stdout.isTTY),
      catch: () => new Error("LOG_FORMAT must be json or pretty"),
    });
    return Effect.flatMap(Effect.result(format), (result) => {
      const run: Effect.Effect<A, E | Error> =
        result._tag === "Success" ? program : Effect.fail(result.failure);
      return run.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Server process failed", cause),
        ),
        Effect.provide(
          Logger.layer([
            makeServerLogger(result._tag === "Success" ? result.success : "json", projectId),
          ]),
        ),
      );
    });
  });

export const runServerMain = <A, E>(program: Effect.Effect<A, E>): void =>
  NodeRuntime.runMain(withServerLogging(program), {
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      // NodeRuntime explicitly exits on failure and signals, even with writes queued.
      if (pendingStdoutWrites === 0) return Runtime.defaultTeardown(exit, onExit);
      const finish = () => {
        if (onStdoutDrained !== finish) return;
        onStdoutDrained = undefined;
        clearTimeout(timeout);
        Runtime.defaultTeardown(exit, onExit);
      };
      const timeout = setTimeout(finish, 1000);
      onStdoutDrained = finish;
    },
  });
