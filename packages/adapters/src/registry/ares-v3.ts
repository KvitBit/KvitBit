/**
 * AresV3: CompanyRegistry over the public ARES v3 REST API.
 *
 * Adapted from DeskoHub packages/ares/src/backend/service.ts (pinned base URL, 5 s timeout,
 * verified-subject check, 404 as "no record"). The response schema is a hand-picked subset of
 * DeskoHub's generated `EkonomickySubjekt` / `Adresa` schemas (packages/ares/src/generated),
 * keeping only the fields RegistryRecord needs; unknown keys are ignored on decode.
 */
import { IsoDate } from "@kvitbit/domain";
import { CompanyRegistry, type RegistryRecord, RegistryUnavailable } from "@kvitbit/domain/ports";
import { type Duration, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** Official ARES REST root. Pinned: callers cannot redirect lookups to another host. */
export const aresBaseUrl = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

export interface AresV3Config {
  /** Upper bound for one lookup, request and body decode included. Default 5 seconds. */
  readonly timeout?: Duration.Input;
}

const defaultTimeout: Duration.Input = "5 seconds";

const OptionalString = Schema.optionalKey(Schema.String);
const OptionalInt = Schema.optionalKey(Schema.Number.check(Schema.isInt()));

/** Subset of ARES `Adresa`. */
const AresAddress = Schema.Struct({
  kodStatu: OptionalString,
  nazevObce: OptionalString,
  nazevCastiObce: OptionalString,
  nazevMestskehoObvodu: OptionalString,
  nazevUlice: OptionalString,
  cisloDomovni: OptionalInt,
  typCisloDomovni: OptionalInt,
  cisloOrientacni: OptionalInt,
  cisloOrientacniPismeno: OptionalString,
  psc: OptionalInt,
  pscTxt: OptionalString,
  textovaAdresa: OptionalString,
});
type AresAddress = typeof AresAddress.Type;

/** Subset of ARES `EkonomickySubjektDalsiUdaje`. */
const AresExtra = Schema.Struct({
  spisovaZnacka: OptionalString,
  datovyZdroj: OptionalString,
});

/** Subset of ARES `EkonomickySubjekt`. */
export const AresSubject = Schema.Struct({
  ico: Schema.String,
  obchodniJmeno: Schema.String.check(
    Schema.makeFilter((name: string) => name.trim().length > 0, { expected: "a non-blank name" }),
  ),
  sidlo: Schema.optionalKey(AresAddress),
  pravniForma: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{3}$/u))),
  dic: OptionalString,
  datumZaniku: Schema.optionalKey(IsoDate),
  dalsiUdaje: Schema.optionalKey(Schema.Array(AresExtra)),
});
export type AresSubject = typeof AresSubject.Type;

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * House number in Czech notation: "čp/čo" with the orientation letter, or "č. ev. N" for a
 * registration number (typCisloDomovni 2).
 */
const houseNumber = (address: AresAddress): string | undefined => {
  const orientation =
    address.cisloOrientacni === undefined
      ? undefined
      : `${address.cisloOrientacni}${address.cisloOrientacniPismeno ?? ""}`;
  if (address.cisloDomovni === undefined) return orientation;
  const domovni =
    address.typCisloDomovni === 2 ? `č. ev. ${address.cisloDomovni}` : `${address.cisloDomovni}`;
  return orientation === undefined ? domovni : `${domovni}/${orientation}`;
};

/**
 * Splits ARES `textovaAdresa` ("Na Florenci 2116/15, Nové Město, 11000 Praha 1") into street,
 * postal code and city. Fills only components the structured fields lack.
 */
const parseTextAddress = (text: string): { street: string; city: string; postalCode: string } => {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = parts.at(-1) ?? "";
  const match = /^(\d{3}) ?(\d{2})\s+(.+)$/u.exec(last);
  if (match === null || parts.length < 2) return { street: text.trim(), city: "", postalCode: "" };
  return { street: parts[0] ?? "", city: match[3] ?? "", postalCode: `${match[1]}${match[2]}` };
};

/**
 * Each component comes from the structured fields when ARES supplies them, else from the
 * parsed `textovaAdresa`, so a partial structured address keeps what ARES did send.
 */
const toAddress = (address: AresAddress | undefined): RegistryRecord["address"] => {
  const country = nonBlank(address?.kodStatu) ?? "CZ";
  if (address === undefined) return { street: "", city: "", postalCode: "", country };
  const text = nonBlank(address.textovaAdresa);
  const parsed = text === undefined ? undefined : parseTextAddress(text);
  const city = nonBlank(address.nazevObce);
  const number = houseNumber(address);
  // Without a structured house number the parsed text line is the most complete street;
  // villages without streets use the part of the municipality (or the municipality).
  const streetName = nonBlank(address.nazevUlice);
  const street =
    number === undefined
      ? (nonBlank(parsed?.street) ?? streetName ?? nonBlank(address.nazevCastiObce) ?? "")
      : `${streetName ?? nonBlank(address.nazevCastiObce) ?? city ?? ""} ${number}`.trim();
  const psc =
    address.psc !== undefined ? String(address.psc).padStart(5, "0") : nonBlank(address.pscTxt);
  return {
    street,
    city: city ?? nonBlank(parsed?.city) ?? "",
    postalCode: psc ?? nonBlank(parsed?.postalCode) ?? "",
    country,
  };
};

/** Commercial register file mark (e.g. "C 12345/MSPH"), preferring the public-register source. */
const registerEntry = (subject: AresSubject): string | null => {
  const extras = subject.dalsiUdaje ?? [];
  const fromPublicRegister = extras.find(
    (extra) => extra.datovyZdroj === "vr" && nonBlank(extra.spisovaZnacka) !== undefined,
  );
  const any = fromPublicRegister ?? extras.find((e) => nonBlank(e.spisovaZnacka) !== undefined);
  return nonBlank(any?.spisovaZnacka) ?? null;
};

/** Maps a decoded ARES subject to the port record. Pure; exported for tests. */
export const toRegistryRecord = (subject: AresSubject): RegistryRecord => ({
  name: subject.obchodniJmeno.trim(),
  address: toAddress(subject.sidlo),
  dic: nonBlank(subject.dic) ?? null,
  legalForm: nonBlank(subject.pravniForma) ?? "",
  registerEntry: registerEntry(subject),
  terminatedOn: subject.datumZaniku ?? null,
});

const decodeSubject = HttpClientResponse.schemaBodyJson(AresSubject);

class UnexpectedStatus {
  readonly _tag = "UnexpectedStatus";
  constructor(readonly status: number) {}
}

class ForeignSubject {
  readonly _tag = "ForeignSubject";
  constructor(readonly ico: string) {}
}

const readResponse = (
  ico: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<RegistryRecord | null, unknown> => {
  if (response.status === 404) return Effect.succeed(null);
  if (response.status !== 200) return Effect.fail(new UnexpectedStatus(response.status));
  return decodeSubject(response).pipe(
    Effect.flatMap((subject) =>
      subject.ico === ico
        ? Effect.succeed(toRegistryRecord(subject))
        : Effect.fail(new ForeignSubject(subject.ico)),
    ),
  );
};

/** Low-cardinality log label; never the payload or the provider message. */
const failureReason = (cause: unknown): string =>
  cause instanceof UnexpectedStatus
    ? `status ${cause.status}`
    : typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        typeof cause._tag === "string"
      ? cause._tag
      : "unknown";

/**
 * Builds the service over the ambient HttpClient. Outcomes: 200 with a matching subject ->
 * record; 404 -> null; IČO not eight digits -> null without a request; anything else
 * (other status, transport error, timeout, malformed body, foreign IČO) -> RegistryUnavailable.
 */
export const make = (config: AresV3Config = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const scopedClient = HttpClient.withScope(client);
    const timeout = config.timeout ?? defaultTimeout;

    const unavailable = (cause: unknown) =>
      Effect.logWarning("ARES company lookup failed").pipe(
        Effect.annotateLogs({ registry: "ares.gov.cz", reason: failureReason(cause) }),
        Effect.andThen(Effect.fail(new RegistryUnavailable({ cause }))),
      );

    const lookup = Effect.fn("AresV3.lookup")(function* (
      ico: string,
    ): Effect.fn.Return<RegistryRecord | null, RegistryUnavailable> {
      // Core validates the checksum; this guard only keeps the path segment safe.
      if (!/^\d{8}$/u.test(ico)) return null;

      const request = HttpClientRequest.get(`${aresBaseUrl}/ekonomicke-subjekty/${ico}`).pipe(
        HttpClientRequest.acceptJson,
      );
      // withScope ties the response body to Effect.scoped, so every exit path releases it.
      return yield* scopedClient.execute(request).pipe(
        Effect.flatMap((response) => readResponse(ico, response)),
        Effect.scoped,
        Effect.timeout(timeout),
        Effect.catch(unavailable),
      );
    });

    return CompanyRegistry.of({ lookup });
  });

/** CompanyRegistry over the ambient HttpClient; for tests and custom transports. */
export const layerHttp = (config: AresV3Config = {}) => Layer.effect(CompanyRegistry, make(config));

/** CompanyRegistry over the platform fetch client. */
export const layerConfig = (config: AresV3Config = {}) =>
  layerHttp(config).pipe(Layer.provide(FetchHttpClient.layer));

/** Default live layer: fetch transport, 5 second timeout. */
export const layer: Layer.Layer<CompanyRegistry> = layerConfig();
