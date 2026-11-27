import { Config, Data, Effect, Option, type Redacted } from "effect";

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

export class InvalidMailForwarderConfig extends Data.TaggedError("InvalidMailForwarderConfig")<{
  readonly field: string;
  readonly reason: string;
}> {
  override get message() {
    return `Invalid mail forwarder config (${this.field}): ${this.reason}`;
  }
}

const optionalNonEmpty = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
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
  const domain = raw.domain.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length === 0) {
    return yield* new InvalidMailForwarderConfig({
      field: "KVITBIT_MAIL_DOMAIN",
      reason: "must be non-empty",
    });
  }

  const mxHost = Option.getOrElse(raw.mxHost, () => `mx.${domain}`)
    .toLowerCase()
    .replace(/\.$/, "");
  const forwardTo = raw.forwardTo.trim().toLowerCase();
  const forwardFrom = Option.getOrElse(raw.forwardFrom, () => `forwarder@${domain}`).toLowerCase();
  const archiveBucket = raw.archiveBucket.trim();
  const aliases = [
    ...new Set(
      raw.aliasesRaw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  ];

  if (aliases.length === 0) {
    return yield* new InvalidMailForwarderConfig({
      field: "KVITBIT_MAIL_ALIASES",
      reason: "must contain at least one explicit alias",
    });
  }
  if (raw.relayMode === "resend" && Option.isNone(raw.resendApiKey)) {
    return yield* new InvalidMailForwarderConfig({
      field: "RESEND_API_KEY",
      reason: "required when KVITBIT_MAIL_RELAY_MODE=resend",
    });
  }

  const allowedRecipients = new Set(aliases.map((alias) => `${alias}@${domain}`));

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
