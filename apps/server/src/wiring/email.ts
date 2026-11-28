import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
/**
 * Live `EmailSender` port wiring under the typed-mode contract:
 * - `production`: real transport (`resend`, `smtp`, or `resend+smtp`) + explicit `EMAIL_FROM`
 *   required at boot, wrapped with structured delivery-failure logging. Non-prod modes (`capture`,
 *   `console`, `disabled`) and missing config fail fast at layer construction — there is no
 *   runtime reject-stub.
 * - `staging` / `preview`: real transport + explicit `EMAIL_FROM` required unless
 *   `KVITBIT_EMAIL_MODE=capture` or `KVITBIT_EMAIL_MODE=console` is explicitly declared.
 * - `development` / `test`: zero-config local DX (`console`/`capture`).
 */

import {
  CONSOLE_PROVIDER,
  layerSmtp,
  makeCaptureEmailSender,
  makeFallbackEmailSender,
  makeResendEmailSender,
  SMTP_DEFAULT_TIMEOUTS,
  type SmtpTransportOptions,
} from "@kvitbit/adapters/email";
import { EmailRejected, EmailSender } from "@kvitbit/domain/ports";
import type * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import {
  type KvitbitEnv,
  liftValidation,
  loadKvitbitEnv,
  resolveEmailConfig,
  resolveKvitbitEnv,
} from "../config-contract";
import { type EmailWiringConfig, EmailWiringConfigSchema } from "./config";

const emailKinds: Readonly<Record<string, string>> = {
  E01: "verification",
  E02: "magic-link",
  E03: "password-reset",
  E04: "invitation",
  E07: "change-email",
};

const authEmailKind = (template: string | undefined): string | undefined =>
  template !== undefined && EffectRecord.has(emailKinds, template)
    ? emailKinds[template]
    : undefined;

const makeConsoleEmailSender = (): EmailSender["Service"] =>
  EmailSender.of({
    send: Effect.fn("EmailSender.send")((message, { idempotencyKey }) =>
      Effect.logInfo("Email (not sent)").pipe(
        Effect.annotateLogs({
          emailKind: authEmailKind(message.tags["template"]) ?? "other",
        }),
        Effect.as({ provider: CONSOLE_PROVIDER, providerMessageId: idempotencyKey }),
      ),
    ),
  });

const logDeliveryFailures = (sender: EmailSender["Service"]): EmailSender["Service"] => {
  const send: EmailSender["Service"]["send"] = Effect.fn("EmailSender.send")((message, options) =>
    sender.send(message, options).pipe(
      Effect.tapError((error) => {
        const emailKind = authEmailKind(message.tags["template"]);
        if (emailKind === undefined) return Effect.void;
        return Effect.logError(
          Schema.is(EmailRejected)(error) ? "Email delivery rejected" : "Email delivery failed",
        ).pipe(
          Effect.annotateLogs({
            event: error._tag,
            emailKind,
            reason: "Email provider failed to deliver",
          }),
        );
      }),
    ),
  );
  return EmailSender.of({ send });
};

/** Parses `smtp://` or `smtps://` URL into nodemailer transport options. */
export const parseSmtpUrl = (
  rawUrl: string,
): {
  readonly transport: SmtpTransportOptions;
  readonly domain: string;
} => {
  const url = new URL(rawUrl);
  const secure = url.protocol === "smtps:";
  const port = url.port !== "" ? Number.parseInt(url.port, 10) : secure ? 465 : 587;
  const auth =
    url.username !== "" || url.password !== ""
      ? {
          user: decodeURIComponent(url.username),
          pass: decodeURIComponent(url.password),
        }
      : undefined;
  const authFields = auth !== undefined ? { auth } : {};
  return {
    transport: {
      ...SMTP_DEFAULT_TIMEOUTS,
      host: url.hostname,
      port,
      secure,
      ...authFields,
    },
    domain: url.hostname || "kvitbit.local",
  };
};

const acquireSmtpSender = (rawUrl: string, from: string) => {
  const { transport, domain } = parseSmtpUrl(rawUrl);
  return Layer.build(layerSmtp(transport, { from, messageIdDomain: domain })).pipe(
    Effect.map((ctx) => Context.get(ctx, EmailSender)),
  );
};

/**
 * Builds an `EmailSender` layer from explicit config and environment (used by live wiring and
 * tests). Fails fast with `Config.ConfigError` whenever the typed-mode contract is violated.
 */
const makeEmailSenderLayerImpl = (
  config: EmailWiringConfig,
  envOrNodeEnv: KvitbitEnv | string = "development",
): Layer.Layer<EmailSender, Config.ConfigError> =>
  Layer.effect(
    EmailSender,
    Effect.gen(function* () {
      const env = yield* liftValidation(resolveKvitbitEnv({ kvitbitEnv: envOrNodeEnv }));
      const resolved = yield* liftValidation(
        resolveEmailConfig(env, {
          emailMode: config.mode,
          emailFrom: config.from,
          resendApiKey: Option.isSome(config.resendApiKey)
            ? Redacted.value(config.resendApiKey.value)
            : undefined,
          smtpUrl: Option.isSome(config.smtpUrl) ? Redacted.value(config.smtpUrl.value) : undefined,
        }),
      );

      const wrap = (sender: EmailSender["Service"]) =>
        env === "production" ? logDeliveryFailures(sender) : sender;

      switch (resolved.mode) {
        case "console":
          return makeConsoleEmailSender();
        case "capture":
          return yield* makeCaptureEmailSender;
        case "resend": {
          const resend = yield* makeResendEmailSender({
            apiKey: Redacted.make(resolved.resendApiKey ?? ""),
            from: resolved.from,
          });
          return wrap(resend);
        }
        case "smtp": {
          const smtp = yield* acquireSmtpSender(resolved.smtpUrl ?? "", resolved.from);
          return wrap(smtp);
        }
        case "resend+smtp": {
          const resend = yield* makeResendEmailSender({
            apiKey: Redacted.make(resolved.resendApiKey ?? ""),
            from: resolved.from,
          });
          const smtp = yield* acquireSmtpSender(resolved.smtpUrl ?? "", resolved.from);
          return wrap(makeFallbackEmailSender({ primary: resend, secondary: smtp }));
        }
      }
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

export const makeEmailSenderLayer: {
  (env?: string): (config: EmailWiringConfig) => ReturnType<typeof makeEmailSenderLayerImpl>;
  (config: EmailWiringConfig, env?: string): ReturnType<typeof makeEmailSenderLayerImpl>;
} = Fn.dual((args) => Predicate.isObject(args[0]), makeEmailSenderLayerImpl);

/** Live `EmailSender` configured from `KVITBIT_ENV`/`NODE_ENV`, `KVITBIT_EMAIL_MODE`, `EMAIL_FROM`, `RESEND_API_KEY`, `KVITBIT_SMTP_URL`. */
export const EmailSenderLive: Layer.Layer<EmailSender, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* loadKvitbitEnv;
    const config = yield* EmailWiringConfigSchema;
    return makeEmailSenderLayer(config, env);
  }),
);
