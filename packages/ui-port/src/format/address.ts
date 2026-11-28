import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";

/**
 * Best-effort parser for pasted postal addresses across Czech, European, UK, US, and Canadian
 * formats, plus a field-merge helper that prefills empty address inputs without overwriting
 * values the user already entered.
 */

const parseCountrySegmentPattern = /^[A-Z]{2}$/;
const normalizePostalCodePattern = /[a-z]/i;
const parseStandalonePostalPattern = /^\d{4}$/;
const looksLikeCityPattern = /^\p{L}/u;
const looksLikeCityPattern2 = /\d+\s*\/\s*\d+/;
const looksLikeCityPattern3 = /\d{3}/;
const looksLikeCityPattern4 = /\d[A-Z]/;
const looksLikeDistrictPattern = /\d/;
const looksLikeStateCodePattern = /^[A-Z]{2,3}$/;
const prahaPragueBrnoPattern =
  /^(?:praha|prague|brno|ostrava|plze[nň]|olomouc|liberec|bratislava|ko[sš]ice)\s+\d{1,2}(?:\s*-\s*[\p{L}\s-]+)?$/iu;
const isPlainFiveDigitPattern = /^\d{5}$/;
const zaZaZaPattern = /\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;
const httpsPattern = /https?:\/\//i;
const parseAddressPattern = /\bwww\./i;
const parseAddressPattern2 = /^[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,}$/i;
const adresaDloSidloPattern = /^(?:adresa|sídlo|sidlo|address)\s*:\s*/iu;
const segmentsPattern = /[\n;|,]+/;
export type AddressField = "street" | "city" | "postalCode" | "country";

export interface AddressFields {
  readonly street: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface ParsedAddress {
  readonly street?: string;
  readonly city?: string;
  readonly postalCode?: string;
  readonly country?: string;
}

export interface AddressPasteOptions {
  /** Whether the form exposes a country field to update from pasted text. Defaults to true. */
  readonly includeCountry?: boolean;
  /** Default country code on a fresh form (for example `"CZ"`), replaced only when all other address fields are empty. */
  readonly defaultCountry?: string;
}

const MAX_ADDRESS_LENGTH = 300;
const MIN_ADDRESS_LENGTH = 5;

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  // Czechia
  czechia: "CZ",
  "czech republic": "CZ",
  "ceska republika": "CZ",
  cesko: "CZ",
  tschechien: "CZ",
  "tschechische republik": "CZ",
  // Slovakia
  slovakia: "SK",
  "slovak republic": "SK",
  slovensko: "SK",
  "slovenska republika": "SK",
  // DACH
  germany: "DE",
  deutschland: "DE",
  nemecko: "DE",
  austria: "AT",
  osterreich: "AT",
  oesterreich: "AT",
  rakousko: "AT",
  switzerland: "CH",
  schweiz: "CH",
  suisse: "CH",
  svizzera: "CH",
  svycarsko: "CH",
  // Central & Eastern Europe
  poland: "PL",
  polska: "PL",
  polsko: "PL",
  hungary: "HU",
  magyarorszag: "HU",
  madarsko: "HU",
  romania: "RO",
  rumunsko: "RO",
  bulgaria: "BG",
  bulharsko: "BG",
  croatia: "HR",
  hrvatska: "HR",
  chorvatsko: "HR",
  slovenia: "SI",
  slovenija: "SI",
  slovinsko: "SI",
  ukraine: "UA",
  ukrajina: "UA",
  estonia: "EE",
  eesti: "EE",
  estonsko: "EE",
  latvia: "LV",
  latvija: "LV",
  lotyssko: "LV",
  lithuania: "LT",
  lietuva: "LT",
  litva: "LT",
  // Western & Southern Europe
  france: "FR",
  francie: "FR",
  italy: "IT",
  italia: "IT",
  italie: "IT",
  spain: "ES",
  espana: "ES",
  spanelsko: "ES",
  portugal: "PT",
  portugalsko: "PT",
  netherlands: "NL",
  "the netherlands": "NL",
  nederland: "NL",
  nizozemsko: "NL",
  nizozemi: "NL",
  holland: "NL",
  belgium: "BE",
  belgie: "BE",
  belgique: "BE",
  belgien: "BE",
  luxembourg: "LU",
  lucembursko: "LU",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "velka britanie": "GB",
  "spojene kralovstvi": "GB",
  ireland: "IE",
  irsko: "IE",
  eire: "IE",
  greece: "GR",
  recko: "GR",
  cyprus: "CY",
  kypr: "CY",
  malta: "MT",
  // Nordics
  sweden: "SE",
  sverige: "SE",
  svedsko: "SE",
  norway: "NO",
  norge: "NO",
  norsko: "NO",
  denmark: "DK",
  danmark: "DK",
  dansko: "DK",
  finland: "FI",
  suomi: "FI",
  finsko: "FI",
  // Non-EU common counterparties
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "spojene staty": "US",
  "spojene staty americke": "US",
  canada: "CA",
  kanada: "CA",
  australia: "AU",
  australie: "AU",
  "new zealand": "NZ",
  "novy zeland": "NZ",
  japan: "JP",
  japonsko: "JP",
  israel: "IL",
  izrael: "IL",
  singapore: "SG",
  singapur: "SG",
};

const ISO2_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "AU",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IL",
  "IT",
  "JP",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "NZ",
  "PL",
  "PT",
  "RO",
  "SE",
  "SG",
  "SI",
  "SK",
  "UA",
  "US",
]);

const POSTAL_COUNTRY_PREFIX: Readonly<Record<string, string>> = {
  A: "AT",
  AT: "AT",
  B: "BE",
  BE: "BE",
  BG: "BG",
  CH: "CH",
  CY: "CY",
  CZ: "CZ",
  D: "DE",
  DE: "DE",
  DK: "DK",
  E: "ES",
  EE: "EE",
  ES: "ES",
  F: "FR",
  FI: "FI",
  FR: "FR",
  GB: "GB",
  GR: "GR",
  H: "HU",
  HR: "HR",
  HU: "HU",
  I: "IT",
  IE: "IE",
  IT: "IT",
  L: "LU",
  LT: "LT",
  LU: "LU",
  LV: "LV",
  N: "NO",
  NL: "NL",
  NO: "NO",
  PL: "PL",
  PT: "PT",
  RO: "RO",
  S: "SE",
  SE: "SE",
  SI: "SI",
  SK: "SK",
};

const collapseSpaces = (value: string): string => Str.trim(Str.replace(/\s+/g, " ")(value));

const stripDiacritics = (value: string): string =>
  Str.toLowerCase(Str.replace(/\p{Diacritic}/gu, "")(Str.normalize("NFD")(value)));

const normalizeCountryKey = (segment: string): string =>
  collapseSpaces(Str.replace(/\./g, " ")(stripDiacritics(segment)));

const parseCountrySegment = (
  segment: string,
  allowIso2: boolean,
  allowCaIso2: boolean,
): string | undefined => {
  const trimmed = collapseSpaces(segment);
  if (trimmed === "") return undefined;

  const key = normalizeCountryKey(trimmed);
  const byName = COUNTRY_NAMES[key];
  if (byName !== undefined) return byName;

  if (key === "c r" || trimmed === "ČR" || trimmed === "Č.R.") return "CZ";
  if (key === "u s a" || key === "u s") return "US";

  if (allowIso2 && parseCountrySegmentPattern.test(trimmed)) {
    if (trimmed === "UK") return "GB";
    if (trimmed === "CA") return allowCaIso2 ? "CA" : undefined;
    if (ISO2_COUNTRIES.has(trimmed)) return trimmed;
  }

  return undefined;
};

const normalizePostalCode = (code: string): string => {
  const cleaned = collapseSpaces(code);
  return normalizePostalCodePattern.test(cleaned) ? Str.toUpperCase(cleaned) : cleaned;
};

interface PostalToken {
  readonly postalCode: string;
  readonly country?: string;
}

const UK_POSTCODE_BODY = "[A-Za-z]{1,2}\\d[A-Za-z\\d]?\\s?\\d[A-Za-z]{2}";
const UK_POSTCODE_SPACED = "[A-Za-z]{1,2}\\d[A-Za-z\\d]?\\s\\d[A-Za-z]{2}";
const CA_POSTCODE_BODY =
  "[ABCEGHJ-NPRSTVXYabceghj-nprstvxy]\\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z]\\s?\\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z]\\d";
const CA_POSTCODE_SPACED =
  "[ABCEGHJ-NPRSTVXYabceghj-nprstvxy]\\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z]\\s\\d[ABCEGHJ-NPRSTV-Zabceghj-nprstv-z]\\d";
const IE_POSTCODE_SPACED =
  "[AC-FHKNPRTV-Yac-fhknprtv-y]\\d[\\dWw]\\s[0-9AC-FHKNPRTV-Yac-fhknprtv-y]{4}";
const NL_POSTCODE_BODY = "\\d{4}\\s?[A-Za-z]{2}";
const NL_POSTCODE_SPACED = "\\d{4}\\s[A-Za-z]{2}";
const PT_POSTCODE_BODY = "\\d{4}-\\d{3}";
const PL_POSTCODE_BODY = "\\d{2}-\\d{3}";
const US_ZIP4_BODY = "\\d{5}-\\d{4}";
const CZ_POSTCODE_BODY = "\\d{3}\\s\\d{2}";

const STANDALONE_POSTAL_REGEX = new RegExp(
  `^(?:([A-Za-z]{1,2})\\s*-\\s*)?(${US_ZIP4_BODY}|${PT_POSTCODE_BODY}|${PL_POSTCODE_BODY}|${CZ_POSTCODE_BODY}|${NL_POSTCODE_BODY}|${UK_POSTCODE_BODY}|${CA_POSTCODE_BODY}|${IE_POSTCODE_SPACED}|\\d{5}|\\d{4})$`,
);

const LEADING_POSTAL_REGEX = new RegExp(
  `^(?:([A-Za-z]{1,2})\\s*-\\s*)?(${US_ZIP4_BODY}|${PT_POSTCODE_BODY}|${PL_POSTCODE_BODY}|${CZ_POSTCODE_BODY}|${NL_POSTCODE_BODY}|${UK_POSTCODE_SPACED}|${CA_POSTCODE_SPACED}|${IE_POSTCODE_SPACED}|\\d{5}|\\d{4})\\s+(.+)$`,
);

const TRAILING_POSTAL_REGEX = new RegExp(
  `^(.+?)\\s+(?:([A-Za-z]{1,2})\\s*-\\s*)?(${US_ZIP4_BODY}|${PT_POSTCODE_BODY}|${PL_POSTCODE_BODY}|${CZ_POSTCODE_BODY}|${NL_POSTCODE_SPACED}|${UK_POSTCODE_BODY}|${CA_POSTCODE_BODY}|${IE_POSTCODE_SPACED}|\\d{5}|\\d{4})$`,
);

const SINGLE_LINE_PREFIXED_REGEX = new RegExp(
  `^(?:(.+?)\\s+)?([A-Za-z]{1,2})\\s*-\\s*(${US_ZIP4_BODY}|${PT_POSTCODE_BODY}|${PL_POSTCODE_BODY}|${CZ_POSTCODE_BODY}|${NL_POSTCODE_BODY}|\\d{5}|\\d{4})\\s+(.+)$`,
);

const SINGLE_LINE_POSTAL_CITY_REGEX = new RegExp(
  `^(?:(.+?)\\s+)?(${US_ZIP4_BODY}|${PT_POSTCODE_BODY}|${PL_POSTCODE_BODY}|${CZ_POSTCODE_BODY}|${NL_POSTCODE_SPACED}|(?<![/-])\\d{5}(?![/-]))\\s+(.+)$`,
);

const SINGLE_LINE_UK_REGEX = new RegExp(`^(.+?)\\s+(${UK_POSTCODE_SPACED})$`);

const CA_POSTCODE_TEST = new RegExp(`^${CA_POSTCODE_BODY}$`);

const UNIT_OR_SUBPREMISE_REGEX =
  /^(?:apt|apartment|suite|ste|unit|floor|fl|room|rm|bldg|building|office|flat|box|p\.?\s*o\.?\s*box|c\/o|patro|budova|vchod|kancelář|kancelar|byt|č\.?\s*p\.?|č\.?\s*ev\.?)\b/iu;

const LEGAL_FORM_REGEX =
  /^(?:s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?|v\.?\s*o\.?\s*s\.?|k\.?\s*s\.?|z\.?\s*s\.?|o\.?\s*s\.?|spol\.?\s*s\s*r\.?\s*o\.?|gmbh|ag|kg|ug|ltd\.?|llc|inc\.?|corp\.?|s\.?\s*a\.?|b\.?\s*v\.?|n\.?\s*v\.?)$/iu;

const STREET_KEYWORD_REGEX =
  /\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|parkway|pkwy\.?|court|ct\.?|way|place|pl\.?|square|sq\.?|ulice|ul\.?|náměstí|nám\.?|třída|tř\.?|nábřeží|nábř\.?|straße|strasse|str\.?|weg|platz|gasse|allee|rue|via|calle)\b/iu;

const parseStandalonePostal = (
  segment: string,
  allowFourDigit: boolean,
): PostalToken | undefined => {
  const m = STANDALONE_POSTAL_REGEX.exec(segment);
  if (m === null) return undefined;
  const rawPrefix = m[1];
  const rawCode = m[2];
  if (rawCode === undefined) return undefined;

  let country: string | undefined;
  if (rawPrefix !== undefined) {
    country = POSTAL_COUNTRY_PREFIX[Str.toUpperCase(rawPrefix)];
    if (country === undefined) return undefined;
  }
  if (!allowFourDigit && country === undefined && parseStandalonePostalPattern.test(rawCode)) {
    return undefined;
  }
  const postalCode = normalizePostalCode(rawCode);
  return country === undefined ? { postalCode } : { postalCode, country };
};

const looksLikeCity = (value: string, strictNoStreetWord = false): boolean => {
  const s = collapseSpaces(value);
  if (s.length < 2) return false;
  if (!looksLikeCityPattern.test(s)) return false;
  if (UNIT_OR_SUBPREMISE_REGEX.test(s)) return false;
  if (LEGAL_FORM_REGEX.test(s)) return false;
  if (looksLikeCityPattern2.test(s)) return false;
  if (looksLikeCityPattern3.test(s)) return false;
  if (looksLikeCityPattern4.test(s)) return false;
  if (strictNoStreetWord && STREET_KEYWORD_REGEX.test(s)) return false;
  return true;
};

const looksLikeDistrict = (value: string): boolean => {
  const s = collapseSpaces(value);
  return s.length >= 2 && !looksLikeDistrictPattern.test(s) && looksLikeCity(s);
};

const looksLikeStateCode = (value: string): boolean =>
  looksLikeStateCodePattern.test(collapseSpaces(value));

const looksLikeNumberedCzechCity = (value: string): boolean =>
  prahaPragueBrnoPattern.test(collapseSpaces(value));

const combineStreetParts = (parts: ReadonlyArray<string>): string | undefined => {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    const first = parts[0] ?? "";
    const second = parts[1] ?? "";
    // Czech ARES / Google Maps format: "Na Florenci 2116/15, Nové Město, 110 00 Praha 1"
    if (looksLikeDistrictPattern.test(first) && looksLikeDistrict(second)) {
      return first;
    }
  }
  return Arr.join(parts, ", ");
};

const buildResult = (
  parts: Partial<Record<AddressField, string | undefined>>,
): ParsedAddress | undefined => {
  const street = parts.street !== undefined && parts.street !== "" ? parts.street : undefined;
  const city = parts.city !== undefined && parts.city !== "" ? parts.city : undefined;
  const postalCode =
    parts.postalCode !== undefined && parts.postalCode !== "" ? parts.postalCode : undefined;
  const country = parts.country !== undefined && parts.country !== "" ? parts.country : undefined;

  const count =
    (street !== undefined ? 1 : 0) +
    (city !== undefined ? 1 : 0) +
    (postalCode !== undefined ? 1 : 0) +
    (country !== undefined ? 1 : 0);

  if (count < 2) return undefined;

  const result: Partial<Record<AddressField, string>> = {};
  if (street !== undefined) result.street = street;
  if (city !== undefined) result.city = city;
  if (postalCode !== undefined) result.postalCode = postalCode;
  if (country !== undefined) result.country = country;
  return result;
};

const trimPart = (part: string | undefined): string | undefined =>
  part === undefined ? undefined : Str.trim(part);

const parseSingleSegment = (segment: string): ParsedAddress | undefined => {
  // Country-prefixed postal code inside a single line: "Na Florenci 2116/15 CZ-110 00 Praha 1" or "CZ-110 00 Praha 1"
  const prefixed = SINGLE_LINE_PREFIXED_REGEX.exec(segment);
  if (prefixed !== null) {
    const street = trimPart(prefixed[1]);
    const rawPrefix = Str.toUpperCase(prefixed[2] ?? "");
    const rawCode = prefixed[3] ?? "";
    const city = Str.trim(prefixed[4] ?? "");
    const country = POSTAL_COUNTRY_PREFIX[rawPrefix];
    if (country !== undefined && looksLikeCity(city, street === undefined)) {
      return buildResult({
        street: street !== undefined && street !== "" ? street : undefined,
        postalCode: normalizePostalCode(rawCode),
        city,
        country,
      });
    }
  }

  // Unmistakable postal code followed by city: "Jankovcova 1522/53 170 00 Praha 7" or "170 00 Praha 7"
  const postalCity = SINGLE_LINE_POSTAL_CITY_REGEX.exec(segment);
  if (postalCity !== null) {
    const street = trimPart(postalCity[1]);
    const rawCode = postalCity[2] ?? "";
    const city = Str.trim(postalCity[3] ?? "");
    const isPlainFiveDigit = isPlainFiveDigitPattern.test(rawCode);
    // Avoid parsing US house numbers like "10001 Main Street" as postal + city.
    if (looksLikeCity(city, street === undefined && isPlainFiveDigit)) {
      return buildResult({
        street: street !== undefined && street !== "" ? street : undefined,
        postalCode: normalizePostalCode(rawCode),
        city,
      });
    }
  }

  // Trailing spaced UK postcode on a single line: "London SW1A 2AA"
  const uk = SINGLE_LINE_UK_REGEX.exec(segment);
  if (uk !== null) {
    const before = Str.trim(uk[1] ?? "");
    const code = uk[2] ?? "";
    if (looksLikeCity(before, true)) {
      return buildResult({
        city: before,
        postalCode: normalizePostalCode(code),
      });
    }
  }

  return undefined;
};

const parseMultiSegment = (segments: ReadonlyArray<string>): ParsedAddress | undefined => {
  const remaining = [...segments];
  let country: string | undefined;

  // Step 1: Extract trailing country segment if present.
  if (remaining.length >= 2) {
    const last = remaining[remaining.length - 1] ?? "";
    const prev = remaining[remaining.length - 2] ?? "";
    const hasCaPostal = CA_POSTCODE_TEST.test(prev) || zaZaZaPattern.test(prev);
    const parsedCountry = parseCountrySegment(
      last,
      remaining.length >= 3 || looksLikeDistrictPattern.test(prev),
      hasCaPostal,
    );
    if (parsedCountry !== undefined) {
      country = parsedCountry;
      remaining.pop();
    }
  }

  if (remaining.length === 0) return undefined;

  if (remaining.length === 1) {
    const single = parseSingleSegment(remaining[0] ?? "");
    if (single !== undefined) {
      const resolvedCountry = country ?? single.country;
      return buildResult({
        ...single,
        country: resolvedCountry !== undefined ? resolvedCountry : undefined,
      });
    }
    if (country !== undefined) {
      const only = remaining[0] ?? "";
      return buildResult(
        looksLikeDistrictPattern.test(only) && !looksLikeNumberedCzechCity(only)
          ? { street: only, country }
          : looksLikeCity(only)
            ? { city: only, country }
            : {},
      );
    }
    return undefined;
  }

  const lastIndex = remaining.length - 1;
  const last = remaining[lastIndex] ?? "";

  // Layout A: Last segment is "<prefix?><postalCode> <city>" (standard CZ / EU format).
  const leading = LEADING_POSTAL_REGEX.exec(last);
  if (leading !== null) {
    const rawPrefix = leading[1];
    const rawCode = leading[2] ?? "";
    const city = Str.trim(leading[3] ?? "");
    const prefixCountry =
      rawPrefix !== undefined ? POSTAL_COUNTRY_PREFIX[Str.toUpperCase(rawPrefix)] : undefined;
    if ((rawPrefix === undefined || prefixCountry !== undefined) && looksLikeCity(city)) {
      const street = combineStreetParts(remaining.slice(0, lastIndex));
      const resolvedCountry = country ?? prefixCountry;
      return buildResult({
        street: street !== undefined ? street : undefined,
        postalCode: normalizePostalCode(rawCode),
        city,
        country: resolvedCountry !== undefined ? resolvedCountry : undefined,
      });
    }
  }

  // Layout B: Last segment is "<city|state> <prefix?><postalCode>" (US / CA / UK / reversed CZ).
  const trailing = TRAILING_POSTAL_REGEX.exec(last);
  if (trailing !== null) {
    const before = Str.trim(trailing[1] ?? "");
    const rawPrefix = trailing[2];
    const rawCode = trailing[3] ?? "";
    const prefixCountry =
      rawPrefix !== undefined ? POSTAL_COUNTRY_PREFIX[Str.toUpperCase(rawPrefix)] : undefined;
    if (rawPrefix === undefined || prefixCountry !== undefined) {
      const resolvedCountry = country ?? prefixCountry;
      if (looksLikeStateCode(before) && remaining.length >= 3) {
        const cityPart = remaining[lastIndex - 1] ?? "";
        if (looksLikeCity(cityPart)) {
          const street = combineStreetParts(remaining.slice(0, lastIndex - 1));
          return buildResult({
            street: street !== undefined ? street : undefined,
            city: `${cityPart}, ${before}`,
            postalCode: normalizePostalCode(rawCode),
            country: resolvedCountry !== undefined ? resolvedCountry : undefined,
          });
        }
      }
      if (looksLikeCity(before)) {
        const street = combineStreetParts(remaining.slice(0, lastIndex));
        return buildResult({
          street: street !== undefined ? street : undefined,
          city: before,
          postalCode: normalizePostalCode(rawCode),
          country: resolvedCountry !== undefined ? resolvedCountry : undefined,
        });
      }
    }
  }

  // Layout C1: Last segment is a standalone postal code ("Street, City, 110 00" or "Street, City, CA, 94043").
  const lastPostal = parseStandalonePostal(last, true);
  if (lastPostal !== undefined) {
    const beforePostal = remaining.slice(0, lastIndex);
    const resolvedCountry = country ?? lastPostal.country;
    if (beforePostal.length === 1) {
      const only = beforePostal[0] ?? "";
      const isCity = !looksLikeDistrictPattern.test(only) || looksLikeNumberedCzechCity(only);
      return buildResult({
        ...(isCity ? { city: only } : { street: only }),
        postalCode: lastPostal.postalCode,
        country: resolvedCountry !== undefined ? resolvedCountry : undefined,
      });
    }
    const prev = beforePostal[beforePostal.length - 1] ?? "";
    if (beforePostal.length >= 3 && looksLikeStateCode(prev)) {
      const cityPart = beforePostal[beforePostal.length - 2] ?? "";
      if (looksLikeCity(cityPart)) {
        const street = combineStreetParts(beforePostal.slice(0, beforePostal.length - 2));
        return buildResult({
          street: street !== undefined ? street : undefined,
          city: `${cityPart}, ${prev}`,
          postalCode: lastPostal.postalCode,
          country: resolvedCountry !== undefined ? resolvedCountry : undefined,
        });
      }
    }
    if (looksLikeCity(prev)) {
      const street = combineStreetParts(beforePostal.slice(0, beforePostal.length - 1));
      return buildResult({
        street: street !== undefined ? street : undefined,
        city: prev,
        postalCode: lastPostal.postalCode,
        country: resolvedCountry !== undefined ? resolvedCountry : undefined,
      });
    }
  }

  // Layout C2: Second-to-last segment is a standalone postal code, last segment is city ("Street, 110 00, Praha 1").
  const prevIndex = lastIndex - 1;
  const prevPostal = parseStandalonePostal(remaining[prevIndex] ?? "", prevIndex > 0);
  if (prevPostal !== undefined && looksLikeCity(last)) {
    const street = combineStreetParts(remaining.slice(0, prevIndex));
    const resolvedCountry = country ?? prevPostal.country;
    return buildResult({
      street: street !== undefined ? street : undefined,
      postalCode: prevPostal.postalCode,
      city: last,
      country: resolvedCountry !== undefined ? resolvedCountry : undefined,
    });
  }

  // Layout D: No postal code, e.g. "Friedrichstraße 123, Berlin, Germany" or "Jankovcova 1522/53, Praha 7".
  if (looksLikeCity(last)) {
    const streetParts = remaining.slice(0, lastIndex);
    const first = streetParts[0] ?? "";
    if (country !== undefined) {
      const street = combineStreetParts(streetParts);
      return buildResult({
        street: street !== undefined ? street : undefined,
        city: last,
        country,
      });
    }
    // Without country or postal code, require a house number in the first segment so company names
    // ("Novak Design, s.r.o.") or prose are never split across fields.
    if (
      looksLikeDistrictPattern.test(first) &&
      (streetParts.length === 1 ||
        (streetParts.length === 2 && looksLikeDistrict(streetParts[1] ?? "")))
    ) {
      const street = combineStreetParts(streetParts);
      return buildResult({ street: street !== undefined ? street : undefined, city: last });
    }
  }

  return undefined;
};

/**
 * Parses a pasted multi-part postal address into structured components.
 * Returns `undefined` for single-field values (just a street, just a city, just a postal code)
 * or non-address text so normal pastes are left untouched.
 */
export const parseAddress = (input: string): ParsedAddress | undefined => {
  const trimmed = Str.trim(input);
  if (trimmed.length < MIN_ADDRESS_LENGTH || trimmed.length > MAX_ADDRESS_LENGTH) {
    return undefined;
  }
  if (
    httpsPattern.test(trimmed) ||
    parseAddressPattern.test(trimmed) ||
    Str.includes("@")(trimmed)
  ) {
    return undefined;
  }
  if (parseAddressPattern2.test(trimmed)) {
    return undefined;
  }

  const unlabeled = Str.replace(adresaDloSidloPattern, "")(trimmed);
  const segments = Arr.filter(
    Arr.map(Str.split(Str.replace(/\r\n?/g, "\n")(unlabeled), segmentsPattern), collapseSpaces),
    (segment) => segment.length > 0,
  );

  if (segments.length === 0) return undefined;
  if (segments.length === 1) return parseSingleSegment(segments[0] ?? "");
  return parseMultiSegment(segments);
};

/**
 * Applies a pasted address to the current address fields.
 * - Sets the pasted target field to its extracted part (when extracted).
 * - Prefills other fields only when they are currently empty.
 * - Updates `country` (when `includeCountry !== false`) if `target === "country"`, if `country` is
 *   empty, or if `country` still holds `defaultCountry` while all other address fields are empty.
 * Returns `undefined` when the text is not a multi-part address or nothing applies.
 */
const applyAddressPasteImpl = (
  current: AddressFields,
  target: AddressField,
  pasted: string,
  options?: AddressPasteOptions,
): AddressFields | undefined => {
  const parsed = parseAddress(pasted);
  if (parsed === undefined) return undefined;

  const includeCountry = options?.includeCountry !== false;
  const defaultCountry =
    options?.defaultCountry === undefined
      ? undefined
      : Str.toUpperCase(Str.trim(options.defaultCountry));

  const next = {
    street: current.street,
    city: current.city,
    postalCode: current.postalCode,
    country: current.country,
  };

  let filledAny = false;
  const textFields: ReadonlyArray<"street" | "city" | "postalCode"> = [
    "street",
    "city",
    "postalCode",
  ];
  for (const field of textFields) {
    const value = parsed[field];
    if (value === undefined) continue;
    if (field === target || Str.trim(current[field]) === "") {
      next[field] = value;
      if (value !== current[field]) filledAny = true;
    }
  }

  if (includeCountry && parsed.country !== undefined) {
    const allTextEmpty =
      Str.trim(current.street) === "" &&
      Str.trim(current.city) === "" &&
      Str.trim(current.postalCode) === "";
    const isUntouchedDefault =
      defaultCountry !== undefined &&
      allTextEmpty &&
      Str.toUpperCase(Str.trim(current.country)) === defaultCountry;
    if (target === "country" || Str.trim(current.country) === "" || isUntouchedDefault) {
      next.country = parsed.country;
      if (parsed.country !== current.country) filledAny = true;
    }
  }

  // Keep intercepting when the target field already holds the exact parsed target part so pasting
  // the same full address into it does not dump the unsplit string into the single input.
  const targetHasExtractedPart =
    target === "country"
      ? includeCountry && parsed.country !== undefined
      : parsed[target] !== undefined;

  if (!(filledAny || targetHasExtractedPart)) return undefined;
  return next;
};

/**
 * Paste-friendly wrapper for `onChangeText` inputs (such as React Native) that lack a separate
 * clipboard paste event. Ignores ordinary character-by-character typing and splits only sudden
 * multi-character insertions or multiline text.
 */
const applyAddressInputChangeImpl = (
  current: AddressFields,
  target: AddressField,
  nextValue: string,
  options?: AddressPasteOptions,
): AddressFields | undefined => {
  const delta = nextValue.length - current[target].length;
  if (delta < 4 && !Str.includes("\n")(nextValue)) return undefined;
  return applyAddressPaste(current, target, nextValue, options);
};

export const applyAddressPaste: {
  (
    target: AddressField,
    pasted: string,
    options?: AddressPasteOptions,
  ): (current: AddressFields) => AddressFields | undefined;
  (
    current: AddressFields,
    target: AddressField,
    pasted: string,
    options?: AddressPasteOptions,
  ): AddressFields | undefined;
} = Fn.dual((args) => Predicate.isObject(args[0]), applyAddressPasteImpl);

export const applyAddressInputChange: typeof applyAddressPaste = Fn.dual(
  (args) => Predicate.isObject(args[0]),
  applyAddressInputChangeImpl,
);
