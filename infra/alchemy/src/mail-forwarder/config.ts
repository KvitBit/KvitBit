import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const trailingDotPattern = /\.$/;

export type MailRelayMode = "archive-only" | "resend";

export interface MailForwarderConfigShape {
  readonly domain: string;
  readonly mxHost: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly aliases: ReadonlyArray<string>;
  readonly allowedRecipients: ReadonlySet<string>;
  readonly archiveBucket: string;
  readonly relayMode: MailRelayMode;
  readonly resendApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly smtpPort: number;
  readonly healthPort: number;
  readonly tlsCertPath: Option.Option<string>;
  readonly tlsKeyPath: Option.Option<string>;
}

export class InvalidMailForwarderConfig extends Schema.TaggedError<
  InvalidMailForwarderConfig,
  { readonly brand: unique symbol }
>()("InvalidMailForwarderConfig", {
  field: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid mail forwarder config (${this.field}): ${this.reason}`;
  }
}

const optionalNonEmpty = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(
      Option.flatMap((value) => {
        const trimmed = Str.trim(value);
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const rawMailForwarderConfig = Config.all({
  domain: Config.String("KVITBIT_MAIL_DOMAIN"),
  mxHost: optionalNonEmpty("KVITBIT_MAIL_MX_HOST"),
  forwardTo: Config.String("KVITBIT_MAIL_FORWARD_TO"),
  forwardFrom: optionalNonEmpty("KVITBIT_MAIL_FORWARD_FROM"),
  aliasesRaw: Config.String("KVITBIT_MAIL_ALIASES"),
  archiveBucket: Config.String("KVITBIT_MAIL_ARCHIVE_BUCKET"),
  relayMode: Config.Literals(["archive-only", "resend"] as const, "KVITBIT_MAIL_RELAY_MODE").pipe(
    Config.withDefault("archive-only" as const),
  ),
  resendApiKey: Config.option(Config.Redacted("RESEND_API_KEY")),
  smtpPort: Config.Int("KVITBIT_MAIL_PORT").pipe(Config.withDefault(2525)),
  healthPort: Config.Int("KVITBIT_MAIL_HEALTH_PORT").pipe(Config.withDefault(8081)),
  tlsCertPath: optionalNonEmpty("KVITBIT_MAIL_TLS_CERT_PATH"),
  tlsKeyPath: optionalNonEmpty("KVITBIT_MAIL_TLS_KEY_PATH"),
});

export const loadMailForwarderConfig: Effect.Effect<
  MailForwarderConfigShape,
  Config.ConfigError | InvalidMailForwarderConfig
> = Effect.gen(function* () {
  const raw = yield* rawMailForwarderConfig;
  const domain = Str.replace(trailingDotPattern, "")(Str.toLowerCase(Str.trim(raw.domain)));
  if (domain.length === 0) {
    return yield* InvalidMailForwarderConfig.make({
      field: "KVITBIT_MAIL_DOMAIN",
      reason: "must be non-empty",
    });
  }

  const mxHost = raw.mxHost.pipe(
    Option.getOrElse(() => `mx.${domain}`),
    Str.toLowerCase,
    Str.replace(trailingDotPattern, ""),
  );
  const forwardTo = Str.toLowerCase(Str.trim(raw.forwardTo));
  const forwardFrom = Str.toLowerCase(
    Option.getOrElse(raw.forwardFrom, () => `forwarder@${domain}`),
  );
  const archiveBucket = Str.trim(raw.archiveBucket);
  const aliases = [
    ...new Set(
      Arr.filter(
        Arr.map(Str.split(raw.aliasesRaw, ","), (item) => Str.toLowerCase(Str.trim(item))),
        (item) => item.length > 0,
      ),
    ),
  ];

  if (aliases.length === 0) {
    return yield* InvalidMailForwarderConfig.make({
      field: "KVITBIT_MAIL_ALIASES",
      reason: "must contain at least one explicit alias",
    });
  }
  if (raw.relayMode === "resend" && Option.isNone(raw.resendApiKey)) {
    return yield* InvalidMailForwarderConfig.make({
      field: "RESEND_API_KEY",
      reason: "required when KVITBIT_MAIL_RELAY_MODE=resend",
    });
  }

  const allowedRecipients = new Set(Arr.map(aliases, (alias) => `${alias}@${domain}`));

  return {
    domain,
    mxHost,
    forwardTo,
    forwardFrom,
    aliases,
    allowedRecipients,
    archiveBucket,
    relayMode: raw.relayMode,
    resendApiKey: raw.resendApiKey,
    smtpPort: raw.smtpPort,
    healthPort: raw.healthPort,
    tlsCertPath: raw.tlsCertPath,
    tlsKeyPath: raw.tlsKeyPath,
  };
});
