/**
 * Live `EmailSender` port wiring in production:
 * - Both `RESEND_API_KEY` and `KVITBIT_SMTP_URL`: Resend primary with SMTP fallback.
 * - Only `RESEND_API_KEY`: Resend.
 * - Only `KVITBIT_SMTP_URL`: SMTP (nodemailer via `@kvitbit/adapters/email`).
 * - Neither: Delivery rejection.
 * Non-production captures email locally. Development with no provider logs it to the console.
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
import { EmailRejected, EmailSender } from "@kvitbit/domain/ports";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
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
  const transport = { ...SMTP_DEFAULT_TIMEOUTS, host: url.hostname, port, secure };
  return {
    transport: auth === undefined ? transport : { ...transport, auth },
    domain: url.hostname || "kvitbit.local",
  };
};

const acquireSmtpSender = (rawUrl: string, from: string) => {
  const { transport, domain } = parseSmtpUrl(rawUrl);
  return Layer.build(layerSmtp(transport, { from, messageIdDomain: domain })).pipe(
    Effect.map((ctx) => Context.get(ctx, EmailSender)),
  );
};

/** Builds an `EmailSender` layer from explicit config (used by live wiring and tests). */
export const makeEmailSenderLayer: {
  (nodeEnv?: string): (config: EmailWiringConfig) => Layer.Layer<EmailSender>;
  (config: EmailWiringConfig, nodeEnv?: string): Layer.Layer<EmailSender>;
} = Fn.dual(
  (args) => Predicate.isObject(args[0]),
  (config: EmailWiringConfig, nodeEnv = "development"): Layer.Layer<EmailSender> =>
    Layer.effect(
      EmailSender,
      Effect.gen(function* () {
        const hasResend = Option.isSome(config.resendApiKey);
        const hasSmtp = Option.isSome(config.smtpUrl);

        if (nodeEnv !== "production") {
          return nodeEnv === "development" && !hasResend && !hasSmtp
            ? makeConsoleEmailSender()
            : yield* makeCaptureEmailSender;
        }

        if (hasResend && hasSmtp) {
          const resend = yield* makeResendEmailSender({
            apiKey: config.resendApiKey.value,
            from: config.from,
          });
          const smtp = yield* acquireSmtpSender(Redacted.value(config.smtpUrl.value), config.from);
          return makeFallbackEmailSender({ primary: resend, secondary: smtp });
        }

        if (hasResend) {
          return yield* makeResendEmailSender({
            apiKey: config.resendApiKey.value,
            from: config.from,
          });
        }

        if (hasSmtp) {
          return yield* acquireSmtpSender(Redacted.value(config.smtpUrl.value), config.from);
        }

        return EmailSender.of({
          send: Effect.fn("EmailSender.send")(() =>
            Effect.fail(EmailRejected.make({ cause: "Email delivery is not configured" })),
          ),
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
);

/** Live `EmailSender` configured from `EMAIL_FROM`, `RESEND_API_KEY`, `KVITBIT_SMTP_URL`. */
export const EmailSenderLive: Layer.Layer<EmailSender, Config.ConfigError> = Layer.unwrap(
  Effect.map(
    Config.all([
      EmailWiringConfigSchema,
      Config.String("NODE_ENV").pipe(Config.withDefault("development")),
    ]),
    ([config, nodeEnv]) => makeEmailSenderLayer(config, nodeEnv),
  ),
);
