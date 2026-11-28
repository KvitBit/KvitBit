import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
/**
 * Effect-managed receive-only RFC 5321 + RFC 3207 (STARTTLS) SMTP server.
 *
 * Security invariants:
 * - Zero open relay: only explicitly allowlisted `<alias>@<domain>` recipients are accepted.
 * - Strictly bounded memory: command lines, total message bytes, concurrent connections,
 *   per-IP concurrency, and per-IP message rate are all hard-capped.
 * - Opportunistic STARTTLS upgrades sockets in-place via `tls.TLSSocket` and clears prior
 *   SMTP transaction state per RFC 3207 section 4.2.
 * - Strict CRLF-terminated `.\r\n` end-of-DATA (blocks SMTP smuggling) + RFC 5321 dot-unstuffing.
 * - Scoped lifecycle via `Effect.acquireRelease`; message handling runs inside the caller's
 *   Effect context via `Effect.runForkWith`.
 */

import net from "node:net";
import tls from "node:tls";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Str from "effect/String";
import { isValidMailbox, trimAsciiWsp } from "./mime";
import type { InboundMessage, RelayResult } from "./relay";

const angleMatchPattern = /^<[ \t]*([^<>]*?)[ \t]*>(.*)$/;
const spaceIdxPattern = /[ \t]/;
const sizePattern = /(?:^|[ \t])SIZE=(\d+)(?:[ \t]|$)/i;
const fromPattern = /^FROM:/i;
const handleCommandLinePattern = /^TO:/i;

export class SmtpBindError extends Schema.TaggedError<
  SmtpBindError,
  { readonly brand: unique symbol }
>()("SmtpBindError", {
  host: Schema.String,
  port: Schema.Finite,
  reason: Schema.String,
}) {}

export interface SmtpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly domain: string;
  readonly mxHost: string;
  readonly allowedRecipients: ReadonlySet<string>;
  readonly onMessage: (message: InboundMessage) => Effect.Effect<RelayResult>;
  readonly tlsCert?: Buffer | string;
  readonly tlsKey?: Buffer | string;
  readonly maxMessageBytes?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerIp?: number;
  readonly maxMessagesPerIpWindow?: number;
  readonly rateWindowMs?: number;
  readonly commandTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  readonly maxRecipients?: number;
  readonly maxBadCommands?: number;
  readonly now?: () => number;
}

export interface RunningSmtpServer {
  readonly server: net.Server;
  readonly port: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 20;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;
const DEFAULT_MAX_MESSAGES_PER_IP_WINDOW = 30;
const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RECIPIENTS = 20;
const DEFAULT_MAX_BAD_COMMANDS = 10;
const MAX_COMMAND_LINE_BYTES = 8192;

const normalizeIp = (raw: string | undefined): string => {
  if (!(raw !== undefined && raw !== "")) return "unknown";
  return Str.startsWith("::ffff:")(raw) ? Str.slice(7)(raw) : raw;
};

/**
 * Parses `MAIL FROM:<addr> [params...]` or `RCPT TO:<addr> [params...]`.
 * Supports RFC 6531 (`SMTPUTF8`) internationalized addresses and RFC 5321 §4.5.1
 * bare `<Postmaster>` recipient syntax when `barePostmasterDomain` is provided.
 */
const parseEnvelopePathImpl = (
  args: string,
  allowEmpty: boolean,
  barePostmasterDomain?: string,
): { address: string; sizeParam?: number } | undefined => {
  const trimmed = trimAsciiWsp(args);
  const angleMatch = Option.getOrNull(Str.match(angleMatchPattern)(trimmed));
  let address: string;
  let rest: string;
  if (angleMatch !== null) {
    address = trimAsciiWsp(angleMatch[1] ?? "");
    rest = trimAsciiWsp(angleMatch[2] ?? "");
  } else {
    const spaceIdx = Option.getOrElse(Str.search(spaceIdxPattern)(trimmed), () => -1);
    address = spaceIdx === -1 ? trimmed : Str.slice(0, spaceIdx)(trimmed);
    rest = spaceIdx === -1 ? "" : trimAsciiWsp(Str.slice(spaceIdx)(trimmed));
  }

  if (address.length === 0) {
    if (!allowEmpty) return undefined;
  } else if (
    !allowEmpty &&
    barePostmasterDomain !== undefined &&
    Str.toLowerCase(address) === "postmaster"
  ) {
    address = `postmaster@${Str.toLowerCase(barePostmasterDomain)}`;
  } else if (!isValidMailbox(address)) {
    return undefined;
  }

  let sizeParam: number | undefined;
  if (rest.length > 0) {
    const sizeMatch = Option.getOrNull(Str.match(sizePattern)(rest));
    if (sizeMatch?.[1] !== undefined && sizeMatch?.[1] !== "") {
      const parsed = Number.parseInt(sizeMatch[1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        sizeParam = parsed;
      }
    }
  }

  const sizeParamFields = sizeParam !== undefined ? { sizeParam } : {};
  return { address: Str.toLowerCase(address), ...sizeParamFields };
};

type EnvelopePath = ReturnType<typeof parseEnvelopePathImpl>;

export const parseEnvelopePath: {
  (allowEmpty: boolean, barePostmasterDomain?: string): (args: string) => EnvelopePath;
  (args: string, allowEmpty: boolean, barePostmasterDomain?: string): EnvelopePath;
} = Fn.dual((args) => Predicate.isString(args[0]), parseEnvelopePathImpl);

const createRawSmtpServer = (
  options: SmtpServerOptions,
  run: (effect: Effect.Effect<void>) => void,
  defaultNow: () => number,
): net.Server => {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const maxMessagesPerIpWindow =
    options.maxMessagesPerIpWindow ?? DEFAULT_MAX_MESSAGES_PER_IP_WINDOW;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const maxRecipients = options.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  const maxBadCommands = options.maxBadCommands ?? DEFAULT_MAX_BAD_COMMANDS;
  const nowFn = options.now ?? defaultNow;
  const tlsEnabled = Boolean(options.tlsCert && options.tlsKey);

  const normalizedAllowed = new Set<string>();
  for (const recipient of options.allowedRecipients) {
    normalizedAllowed.add(Str.toLowerCase(Str.trim(recipient)));
  }

  let activeConnections = 0;
  const ipConnections = new Map<string, number>();
  const ipMessageTimestamps = new Map<string, Array<number>>();

  const recordAndCheckRateLimit = (ip: string): boolean => {
    const now = nowFn();
    const cutoff = now - rateWindowMs;
    const recent = Arr.filter(ipMessageTimestamps.get(ip) ?? [], (ts) => ts >= cutoff);
    if (recent.length >= maxMessagesPerIpWindow) {
      ipMessageTimestamps.set(ip, recent);
      return false;
    }
    recent.push(now);
    ipMessageTimestamps.set(ip, recent);
    if (ipMessageTimestamps.size > 1000) {
      for (const [key, list] of ipMessageTimestamps) {
        const pruned = Arr.filter(list, (ts) => ts >= cutoff);
        if (pruned.length === 0) ipMessageTimestamps.delete(key);
        else ipMessageTimestamps.set(key, pruned);
      }
    }
    return true;
  };

  return net.createServer((rawSocket) => {
    const remoteIp = normalizeIp(rawSocket.remoteAddress);
    const currentForIp = ipConnections.get(remoteIp) ?? 0;

    if (activeConnections >= maxConnections || currentForIp >= maxConnectionsPerIp) {
      rawSocket.write("421 4.7.0 Too many connections, try again later\r\n");
      rawSocket.end();
      return;
    }

    activeConnections += 1;
    ipConnections.set(remoteIp, currentForIp + 1);

    let socket: net.Socket | tls.TLSSocket = rawSocket;
    let isTls = false;
    let closed = false;
    let heloDomain = "";
    let mailFrom: string | undefined;
    let rcptTo: Array<string> = [];
    let badCommands = 0;

    let mode: "command" | "data" = "command";
    let buffer: Buffer = Buffer.alloc(0);
    let dataChunks: Array<Buffer> = [];
    let dataBytes = 0;
    let dataOversized = false;
    let prevDataLineHadCrlf = true;
    let processing = false;

    const sessionTimer = setTimeout(() => {
      if (!closed) {
        writeLine("421 4.4.2 Session time limit exceeded");
        closeSocket();
      }
    }, sessionTimeoutMs);

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!closed) {
          writeLine("421 4.4.2 Idle timeout");
          closeSocket();
        }
      }, commandTimeoutMs);
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(sessionTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      activeConnections = Math.max(0, activeConnections - 1);
      const count = (ipConnections.get(remoteIp) ?? 1) - 1;
      if (count <= 0) ipConnections.delete(remoteIp);
      else ipConnections.set(remoteIp, count);
    };

    const writeLine = (line: string) => {
      if (!(closed || socket.destroyed)) {
        socket.write(`${line}\r\n`);
      }
    };

    const closeSocket = () => {
      if (!socket.destroyed) {
        socket.end();
      }
      cleanup();
    };

    const resetTransaction = () => {
      mailFrom = undefined;
      rcptTo = [];
      dataChunks = [];
      dataBytes = 0;
      dataOversized = false;
    };

    const handleBadCommand = (code: string) => {
      badCommands += 1;
      writeLine(code);
      if (badCommands >= maxBadCommands) {
        writeLine("421 4.7.0 Too many bad commands");
        closeSocket();
      }
    };

    const upgradeToTls = () => {
      const currentRaw = socket;
      currentRaw.removeAllListeners("data");
      currentRaw.removeAllListeners("error");
      currentRaw.removeAllListeners("close");
      buffer = Buffer.alloc(0);
      heloDomain = "";
      resetTransaction();

      currentRaw.resume();
      const tlsSocket = new tls.TLSSocket(currentRaw, {
        isServer: true,
        key: options.tlsKey,
        cert: options.tlsCert,
      });
      socket = tlsSocket;
      isTls = true;
      attachSocketListeners(tlsSocket);
      resetIdleTimer();
    };

    const handleCommandLine = (line: string): "continue" | "stop" => {
      const spaceIdx = Option.getOrElse(Str.search(spaceIdxPattern)(line), () => -1);
      const verb = Str.toUpperCase(spaceIdx === -1 ? line : Str.slice(0, spaceIdx)(line));
      const args = spaceIdx === -1 ? "" : trimAsciiWsp(Str.slice(spaceIdx)(line));

      switch (verb) {
        case "EHLO": {
          if (!(args !== "")) {
            handleBadCommand("501 5.5.4 Syntax: EHLO hostname");
            return "continue";
          }
          heloDomain = Str.slice(0, 255)(args);
          resetTransaction();
          const extensions = [
            options.mxHost,
            `SIZE ${maxMessageBytes}`,
            "8BITMIME",
            "SMTPUTF8",
            ...(tlsEnabled && !isTls ? ["STARTTLS"] : []),
          ];
          for (let i = 0; i < extensions.length; i += 1) {
            const sep = i === extensions.length - 1 ? " " : "-";
            writeLine(`250${sep}${extensions[i]}`);
          }
          return "continue";
        }

        case "HELO": {
          if (!(args !== "")) {
            handleBadCommand("501 5.5.4 Syntax: HELO hostname");
            return "continue";
          }
          heloDomain = Str.slice(0, 255)(args);
          resetTransaction();
          writeLine(`250 ${options.mxHost}`);
          return "continue";
        }

        case "STARTTLS": {
          if (!tlsEnabled || isTls) {
            handleBadCommand("503 5.5.1 STARTTLS not available");
            return "continue";
          }
          if (args.length > 0) {
            handleBadCommand("501 5.5.4 Syntax: STARTTLS");
            return "continue";
          }
          if (buffer.length > 0) {
            writeLine("501 5.5.4 Cannot pipeline commands after STARTTLS");
            closeSocket();
            return "stop";
          }
          writeLine("220 2.0.0 Ready to start TLS");
          upgradeToTls();
          return "stop";
        }

        case "MAIL": {
          if (!(heloDomain !== "")) {
            handleBadCommand("503 5.5.1 Send EHLO/HELO first");
            return "continue";
          }
          if (!fromPattern.test(args)) {
            handleBadCommand("501 5.5.4 Syntax: MAIL FROM:<address>");
            return "continue";
          }
          const parsed = parseEnvelopePath(Str.slice(5)(args), true);
          if (!(parsed !== undefined)) {
            handleBadCommand("501 5.1.7 Bad sender address syntax");
            return "continue";
          }
          if (parsed.sizeParam !== undefined && parsed.sizeParam > maxMessageBytes) {
            writeLine("552 5.3.4 Message size exceeds fixed maximum message size");
            return "continue";
          }
          resetTransaction();
          mailFrom = parsed.address;
          writeLine("250 2.1.0 OK");
          return "continue";
        }

        case "RCPT": {
          if (mailFrom === undefined) {
            handleBadCommand("503 5.5.1 Need MAIL command");
            return "continue";
          }
          if (!handleCommandLinePattern.test(args)) {
            handleBadCommand("501 5.5.4 Syntax: RCPT TO:<address>");
            return "continue";
          }
          if (rcptTo.length >= maxRecipients) {
            writeLine("452 4.5.3 Too many recipients");
            return "continue";
          }
          const parsed = parseEnvelopePath(Str.slice(3)(args), false, options.domain);
          if (parsed === undefined || parsed.address === "") {
            handleBadCommand("501 5.1.3 Bad recipient address syntax");
            return "continue";
          }
          if (!normalizedAllowed.has(parsed.address)) {
            writeLine("550 5.1.1 User unknown");
            return "continue";
          }
          if (!rcptTo.includes(parsed.address)) {
            rcptTo.push(parsed.address);
          }
          writeLine("250 2.1.5 OK");
          return "continue";
        }

        case "DATA": {
          if (mailFrom === undefined || rcptTo.length === 0) {
            handleBadCommand("503 5.5.1 Need MAIL and RCPT commands");
            return "continue";
          }
          if (!recordAndCheckRateLimit(remoteIp)) {
            writeLine("421 4.7.1 Rate limit exceeded, try again later");
            closeSocket();
            return "stop";
          }
          mode = "data";
          dataChunks = [];
          dataBytes = 0;
          dataOversized = false;
          prevDataLineHadCrlf = true;
          writeLine("354 End data with <CR><LF>.<CR><LF>");
          return "continue";
        }

        case "RSET": {
          resetTransaction();
          writeLine("250 2.0.0 OK");
          return "continue";
        }

        case "NOOP": {
          writeLine("250 2.0.0 OK");
          return "continue";
        }

        case "VRFY": {
          writeLine("252 2.5.2 Cannot VRFY user");
          return "continue";
        }

        case "QUIT": {
          writeLine(`221 2.0.0 ${options.mxHost} closing connection`);
          closeSocket();
          return "stop";
        }

        default: {
          handleBadCommand("500 5.5.1 Command unrecognized");
          return "continue";
        }
      }
    };

    const appendDataLine = (rawLine: Buffer) => {
      if (dataOversized) return;
      const unstuffed =
        rawLine.length >= 2 && rawLine[0] === 46 && rawLine[1] === 46
          ? rawLine.subarray(1)
          : rawLine;
      const needed = unstuffed.byteLength + 2;
      if (dataBytes + needed > maxMessageBytes) {
        dataOversized = true;
        dataChunks = [];
        return;
      }
      dataChunks.push(Buffer.from(unstuffed), Buffer.from("\r\n"));
      dataBytes += needed;
    };

    const readBufferedLines = Effect.gen(function* () {
      while (!closed) {
        const lfIdx = buffer.indexOf(10);
        if (lfIdx === -1) {
          if (mode === "command" && buffer.length > MAX_COMMAND_LINE_BYTES) {
            writeLine("500 5.5.2 Line too long");
            closeSocket();
            return;
          }
          if (mode === "data" && buffer.length > maxMessageBytes) {
            dataOversized = true;
            dataChunks = [];
            buffer = Buffer.alloc(0);
          }
          break;
        }

        const hasCrlf = lfIdx > 0 && buffer[lfIdx - 1] === 13;
        const lineEnd = hasCrlf ? lfIdx - 1 : lfIdx;
        const lineBuf = buffer.subarray(0, lineEnd);
        buffer = buffer.subarray(lfIdx + 1);
        resetIdleTimer();

        if (mode === "command") {
          if (lineBuf.length > MAX_COMMAND_LINE_BYTES) {
            writeLine("500 5.5.2 Line too long");
            closeSocket();
            return;
          }
          const status = handleCommandLine(lineBuf.toString("utf8"));
          if (status === "stop") return;
        } else if (prevDataLineHadCrlf && hasCrlf && lineBuf.length === 1 && lineBuf[0] === 46) {
          mode = "command";
          prevDataLineHadCrlf = true;
          const oversized = dataOversized;
          const rawBytes = oversized ? new Uint8Array(0) : Buffer.concat(dataChunks);
          const currentMailFrom = mailFrom ?? "";
          const currentRcptTo = [...rcptTo];
          resetTransaction();

          if (oversized) {
            writeLine("552 5.3.4 Message size exceeds fixed maximum message size");
            continue;
          }

          const message = {
            remoteIp,
            tls: isTls,
            helo: heloDomain,
            mailFrom: currentMailFrom,
            rcptTo: currentRcptTo,
            rawBytes,
          };
          const result = yield* Effect.suspend(() => options.onMessage(message)).pipe(
            Effect.catchDefect(() =>
              Effect.succeed({
                smtpCode: 451 as const,
                smtpMessage: "4.3.0 Temporary local error",
              }),
            ),
          );
          writeLine(`${result.smtpCode} ${result.smtpMessage}`);
        } else {
          prevDataLineHadCrlf = hasCrlf;
          appendDataLine(lineBuf);
        }
      }
    });
    const processBuffer = readBufferedLines.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          processing = false;
          if (!(closed || socket.destroyed)) socket.resume();
        }),
      ),
    );

    const attachSocketListeners = (target: net.Socket | tls.TLSSocket) => {
      target.on("data", (chunk: Buffer) => {
        if (closed) return;
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        if (processing) return;
        processing = true;
        socket.pause();
        run(processBuffer);
      });
      target.on("error", () => {
        cleanup();
      });
      target.on("close", () => {
        cleanup();
      });
    };

    attachSocketListeners(rawSocket);
    resetIdleTimer();
    writeLine(`220 ${options.mxHost} ESMTP Kvitbit`);
  });
};

export const startSmtpServer = (
  options: SmtpServerOptions,
): Effect.Effect<RunningSmtpServer, SmtpBindError, Scope.Scope> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context();
    const runWithCtx = Effect.runForkWith(ctx);
    const clock = yield* Clock.Clock;
    const server = createRawSmtpServer(
      options,
      (effect) => {
        runWithCtx(effect);
      },
      () => clock.currentTimeMillisUnsafe(),
    );

    return yield* Effect.acquireRelease(
      Effect.callback<RunningSmtpServer, SmtpBindError>((resume) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          resume(
            Effect.fail(
              SmtpBindError.make({
                host: options.host,
                port: options.port,
                reason: error.message,
              }),
            ),
          );
        };
        const onListening = () => {
          server.off("error", onError);
          const addr = server.address();
          const boundPort = addr === null || Predicate.isString(addr) ? options.port : addr.port;
          resume(Effect.succeed({ server, port: boundPort }));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      }),
      ({ server: running }) =>
        Effect.callback<void>((resume) => {
          running.close(() => resume(Effect.void));
        }),
    );
  });
