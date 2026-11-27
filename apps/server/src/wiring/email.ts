/**
 * Live `EmailSender` port wiring under the typed-mode contract:
 * - `production`: real transport (`resend`, `smtp`, or `resend+smtp`) + explicit `EMAIL_FROM`
 *   required at boot. Non-prod modes (`capture`, `console`, `disabled`) and missing config fail
 *   fast at layer construction — there is no runtime reject-stub.
 * - `staging` / `preview`: real transport + explicit `EMAIL_FROM` required unless
 *   `KVITBIT_EMAIL_MODE=capture` or `KVITBIT_EMAIL_MODE=console` is explicitly declared.
 * - `development` / `test`: zero-config local DX (`console`/`capture`).
 */
import {
  layerSmtp,
  makeCaptureEmailSender,
  makeConsoleEmailSender,
  makeFallbackEmailSender,
  makeResendEmailSender,
  SMTP_DEFAULT_TIMEOUTS,
  type SmtpTransportOptions,
} from "@kvitbit/adapters/email";
import { EmailSender } from "@kvitbit/domain/ports";
import { type Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  type KvitbitEnv,
  liftValidation,
  loadKvitbitEnv,
  resolveEmailConfig,
  resolveKvitbitEnv,
} from "../config-contract";
import { type EmailWiringConfig, EmailWiringConfigSchema } from "./config";

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
  return {
    transport: {
      ...SMTP_DEFAULT_TIMEOUTS,
      host: url.hostname,
      port,
      secure,
      ...(auth !== undefined ? { auth } : {}),
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
export const makeEmailSenderLayer = (
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

      switch (resolved.mode) {
        case "console":
          return makeConsoleEmailSender();
        case "capture":
          return yield* makeCaptureEmailSender;
        case "resend":
          return yield* makeResendEmailSender({
            apiKey: Redacted.make(resolved.resendApiKey ?? ""),
            from: resolved.from,
          });
        case "smtp":
          return yield* acquireSmtpSender(resolved.smtpUrl ?? "", resolved.from);
        case "resend+smtp": {
          const resend = yield* makeResendEmailSender({
            apiKey: Redacted.make(resolved.resendApiKey ?? ""),
            from: resolved.from,
          });
          const smtp = yield* acquireSmtpSender(resolved.smtpUrl ?? "", resolved.from);
          return makeFallbackEmailSender(resend, smtp);
        }
      }
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/** Live `EmailSender` configured from `KVITBIT_ENV`/`NODE_ENV`, `KVITBIT_EMAIL_MODE`, `EMAIL_FROM`, `RESEND_API_KEY`, `KVITBIT_SMTP_URL`. */
export const EmailSenderLive: Layer.Layer<EmailSender, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* loadKvitbitEnv;
    const config = yield* EmailWiringConfigSchema;
    return makeEmailSenderLayer(config, env);
  }),
);
