import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
/**
 * Effect-based runtime entrypoint for the Kvitbit Always-Free GCP inbound mail forwarder.
 *
 * Composes `MailRelay` (`FetchHttpClient`), the scoped SMTP server (`startSmtpServer`), and a
 * loopback `/healthz` `HttpRouter` (`BunHttpServer`) under `Logger.consoleJson` and launches
 * with `BunRuntime.runMain` for clean scoped signal shutdown.
 */

import { BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { loadMailForwarderConfig, type MailForwarderConfigShape } from "./config";
import { layerMailRelay, MailRelay } from "./relay";
import { startSmtpServer } from "./smtp";

const readOptionalTlsMaterial = Effect.fn("readOptionalTlsMaterial")(function* (
  config: MailForwarderConfigShape,
) {
  if (Option.isNone(config.tlsCertPath) || Option.isNone(config.tlsKeyPath)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const certExists = yield* fs
    .exists(config.tlsCertPath.value)
    .pipe(Effect.orElseSucceed(() => false));
  const keyExists = yield* fs
    .exists(config.tlsKeyPath.value)
    .pipe(Effect.orElseSucceed(() => false));
  if (!(certExists && keyExists)) {
    return;
  }
  const cert = yield* fs.readFile(config.tlsCertPath.value);
  const key = yield* fs.readFile(config.tlsKeyPath.value);
  return {
    tlsCert: Buffer.from(cert),
    tlsKey: Buffer.from(key),
  };
});

const makeHealthRoutes = (config: MailForwarderConfigShape, tlsEnabled: boolean) =>
  HttpRouter.add(
    "GET",
    "/healthz",
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({
        status: "ok",
        mxHost: config.mxHost,
        relayMode: config.relayMode,
        tlsEnabled,
        aliasCount: config.allowedRecipients.size,
      }),
    ),
  );

export const MailForwarderLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* loadMailForwarderConfig;
    const tlsMaterial = yield* readOptionalTlsMaterial(config);
    const tlsEnabled = tlsMaterial !== undefined;

    const relayLayer = layerMailRelay({
      domain: config.domain,
      forwardTo: config.forwardTo,
      forwardFrom: config.forwardFrom,
      archiveBucket: config.archiveBucket,
      relayMode: config.relayMode,
      resendApiKey: config.resendApiKey,
    }).pipe(Layer.provide(FetchHttpClient.layer));

    const smtpLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const relay = yield* MailRelay;
        const bound = yield* startSmtpServer({
          host: "0.0.0.0",
          port: config.smtpPort,
          domain: config.domain,
          mxHost: config.mxHost,
          allowedRecipients: config.allowedRecipients,
          onMessage: relay.handleMessage,
          ...(tlsMaterial ?? {}),
        });
        yield* Effect.logInfo("mail_forwarder_started", {
          mxHost: config.mxHost,
          domain: config.domain,
          smtpPort: bound.port,
          relayMode: config.relayMode,
          tlsEnabled,
          aliases: [...config.allowedRecipients].sort(Order.String),
        });
      }),
    ).pipe(Layer.provide(relayLayer));

    const healthLayer = HttpRouter.serve(makeHealthRoutes(config, tlsEnabled)).pipe(
      Layer.provide(
        BunHttpServer.layer({
          hostname: "127.0.0.1",
          port: config.healthPort,
        }),
      ),
    );

    return Layer.mergeAll(smtpLayer, healthLayer);
  }),
).pipe(Layer.provide(BunFileSystem.layer));

export const mailForwarderProgram = Layer.launch(MailForwarderLive).pipe(
  Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleJson])),
);

const isMain = Predicate.isBoolean(import.meta.main)
  ? import.meta.main
  : Str.endsWith("server.ts")(process.argv[1] ?? "") ||
    Str.endsWith("mail-forwarder.mjs")(process.argv[1] ?? "");

if (isMain) {
  BunRuntime.runMain(mailForwarderProgram);
}
