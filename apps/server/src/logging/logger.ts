import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type LogValue, redactLogText, sanitizeLogValue } from "./redact";
import { RequestLogContext } from "./trace";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const encodePrettyJsonValue = Schema.encodeResult(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);
const encodePrettyJson = Fn.flow(encodePrettyJsonValue, Result.getOrThrow);

type LogFormat = "json" | "pretty";
const MAX_JSON_BYTES = 200 * 1024;
const escapeControl = (value: string): string =>
  `\\u${Str.padStart(4, "0")(Option.getOrElse(Str.charCodeAt(value, 0), () => Number.NaN).toString(16))}`;

const logFormatErrorMessage = "LOG_FORMAT must be json or pretty";

class InvalidLogFormat extends Schema.TaggedError<
  InvalidLogFormat,
  { readonly brand: unique symbol }
>()("InvalidLogFormat", { message: Schema.Literal(logFormatErrorMessage) }) {}

const prettyMetadataControls = /[\u007f-\u009f\u2028\u2029]/u;
const prettyLineControls = /[\p{Cc}\u2028\u2029]/u;
const escapeControls = (text: string, pattern: RegExp): string =>
  Arr.join(
    Array.from(text, (character) =>
      pattern.test(character) ? escapeControl(character) : character,
    ),
    "",
  );

const selectLogFormatImpl = (
  explicit: string | undefined,
  nodeEnv: string | undefined,
  isTTY: boolean | undefined,
): LogFormat => {
  const format: string | undefined = explicit === undefined ? undefined : Str.toLowerCase(explicit);
  if (format === "json" || format === "pretty") return format;
  if (format !== undefined)
    return Result.getOrThrowWith(
      Result.fail(InvalidLogFormat.make({ message: logFormatErrorMessage })),
      (error) => error,
    );
  return isTTY === true && nodeEnv !== "production" ? "pretty" : "json";
};

export const selectLogFormat: {
  (
    nodeEnv: string | undefined,
    isTTY: boolean | undefined,
  ): (explicit: string | undefined) => LogFormat;
  (
    explicit: string | undefined,
    nodeEnv: string | undefined,
    isTTY: boolean | undefined,
  ): LogFormat;
} = Fn.dual(3, selectLogFormatImpl);

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
    if (error !== undefined && error !== null) {
      failStdout();
    } else if (!stdoutFailed && --pendingStdoutWrites === 0) {
      onStdoutDrained?.();
    }
  };
  Result.try({ try: () => stdout.write(line, done), catch: failStdout });
};

export const makeServerLogger = ({
  format,
  projectId,
  write = writeStdout,
}: {
  readonly format: LogFormat;
  readonly projectId?: string | undefined;
  readonly write?: (line: string) => void;
}) =>
  Logger.make(({ cause, date, fiber, logLevel, message }) => {
    const severity = cloudSeverity[logLevel];
    const formatted = Result.try({
      try: () => {
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
        const spans = EffectRecord.fromEntries(
          Arr.map(fiber.getRef(References.CurrentLogSpans), ([label, start]) => [
            label,
            +date - start,
          ]),
        );
        const [first, ...details] = Arr.isArray(message) ? message : [message];
        const requestIdFields = Predicate.isString(id) ? { requestId: redactLogText(id) } : {};
        const loggingGoogleapisComSpanIdFields =
          trace?.spanId === undefined ? {} : { "logging.googleapis.com/spanId": trace.spanId };
        const loggingGoogleapisComTraceSampledFields =
          trace?.sampled === undefined
            ? {}
            : { "logging.googleapis.com/trace_sampled": trace.sampled };
        const headline = {
          severity,
          message: Predicate.isString(first)
            ? redactLogText(first)
            : first === undefined
              ? "Effect log"
              : Predicate.isObject(first)
                ? encodeJson(sanitizeLogValue(first))
                : String(sanitizeLogValue(first)),
          timestamp,
          ...requestIdFields,
          ...(trace !== undefined && projectId !== undefined && projectId !== ""
            ? { "logging.googleapis.com/trace": `projects/${projectId}/traces/${trace.traceId}` }
            : trace !== undefined
              ? { traceId: trace.traceId }
              : {}),
          ...loggingGoogleapisComSpanIdFields,
          ...loggingGoogleapisComTraceSampledFields,
        };
        const annotatedFields: Readonly<Record<string, LogValue>> = Predicate.isObject(annotated)
          ? annotated
          : {};
        const detailsFields = details.length > 0 ? { details: sanitizeLogValue(details) } : {};
        const causeFields = cause.reasons.length > 0 ? { cause: sanitizeLogValue(cause) } : {};
        const entry = {
          ...headline,
          annotations:
            route === undefined
              ? annotated
              : {
                  ...annotatedFields,
                  "http.route": route,
                },
          spans: sanitizeLogValue(spans),
          ...detailsFields,
          ...causeFields,
        };
        if (format === "json") {
          const serialized = encodeJson(entry);
          write(
            `${
              Buffer.byteLength(serialized) <= MAX_JSON_BYTES
                ? serialized
                : encodeJson({ ...headline, message: "Log entry exceeded the size limit" })
            }\n`,
          );
        } else {
          const {
            message: loggedMessage,
            timestamp: loggedAt,
            severity: loggedSeverity,
            annotations: fields,
            spans: timings,
            ...metadata
          } = entry;
          const annotationsFields =
            EffectRecord.keys(annotations).length > 0 ? { annotations: fields } : {};
          const spansFields = EffectRecord.keys(spans).length > 0 ? { spans: timings } : {};
          const context = Object.assign(
            EffectRecord.empty<string, LogValue>(),
            metadata,
            annotationsFields,
            spansFields,
          );
          const expanded =
            EffectRecord.keys(context).length > 0
              ? `\n${escapeControls(encodePrettyJson(context), prettyMetadataControls)}`
              : "";
          write(
            `[${loggedAt}] ${loggedSeverity} ${escapeControls(loggedMessage, prettyLineControls)}${expanded}\n`,
          );
        }
      },
      catch: () => "LogFormattingFailed" as const,
    });
    if (Result.isFailure(formatted)) {
      // A formatting or sink failure must never fail the Effect that is logging.
      Result.try({
        try: () => {
          const timestamp = DateTime.formatIso(DateTime.nowUnsafe());
          const fallbackMessage = "Unable to write log details";
          write(
            format === "json"
              ? `${encodeJson({ severity, timestamp, message: fallbackMessage })}\n`
              : `[${timestamp}] ${severity} ${fallbackMessage}\n`,
          );
        },
        catch: () => "LogSinkUnavailable" as const,
      });
    }
  });

const withServerLogging = Effect.fn("withServerLogging")(function* <A, E>(
  program: Effect.Effect<A, E>,
) {
  const optional = (name: string) => Config.option(Config.String(name));
  const env = yield* Config.all({
    format: optional("LOG_FORMAT"),
    nodeEnv: optional("NODE_ENV"),
    googleProject: optional("GOOGLE_CLOUD_PROJECT"),
    gcpProject: optional("GCP_PROJECT"),
    kvitbitProject: optional("KVITBIT_GCP_PROJECT_ID"),
    storageProject: optional("KVITBIT_GCS_PROJECT"),
  });
  const projectId = Option.getOrUndefined(
    Arr.findFirst(
      Arr.map(
        [env.googleProject, env.gcpProject, env.kvitbitProject, env.storageProject],
        (value) => Str.trim(Option.getOrElse(value, () => "")),
      ),
      (value) => value !== "",
    ),
  );
  const format = Effect.try({
    try: () =>
      selectLogFormat(
        Option.getOrUndefined(env.format),
        Option.getOrUndefined(env.nodeEnv),
        process.stdout.isTTY,
      ),
    catch: () => InvalidLogFormat.make({ message: logFormatErrorMessage }),
  });
  const result = yield* Effect.result(format);
  const run: Effect.Effect<A, E | InvalidLogFormat> =
    result._tag === "Success" ? program : Effect.fail(result.failure);
  return yield* run.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("Server process failed", cause),
    ),
    Effect.provideService(
      Logger.CurrentLoggers,
      new Set([
        makeServerLogger({
          format: result._tag === "Success" ? result.success : "json",
          projectId,
        }),
      ]),
    ),
  );
});

export const runServerMain = <A, E>(program: Effect.Effect<A, E>): void =>
  NodeRuntime.runMain(
    withServerLogging(program).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
      ),
    ),
    {
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
    },
  );
