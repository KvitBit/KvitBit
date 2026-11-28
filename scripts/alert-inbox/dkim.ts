import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
/**
 * RFC 6376 / RFC 8301 / RFC 8463 cryptographic DKIM verifier for programmatic alert ingestion.
 *
 * Security & standards invariants:
 * - Verifies raw RFC 5322 wire bytes directly (`rsa-sha256` with >= 1024-bit modulus per RFC 8301
 *   §3.2, and `ed25519-sha256` verifying the SHA-256 digest of the canonicalized signing input per
 *   RFC 8463 §3.3; rejects SHA-1).
 * - Preserves RFC 6376 §3.2 case-sensitive tag names (`ALPHA *(ALPHA / DIGIT / "_")`), ignoring
 *   unknown extension tags (e.g. `V=custom`) while rejecting exact duplicate tags and invalid
 *   tag-name grammar.
 * - Rejects `l=` body-length tags, expired `x=` signatures, revoked keys (`p=`), non-email DNS key
 *   services (`s=` without `*` or `email`), and `t=s` identity mismatches (`i=` domain vs `d=` per
 *   RFC 6376 §3.6.1).
 * - Rejects missing or duplicate `From:` headers, requires `from` in `h=`, and enforces both
 *   signing-domain (`d=`) allowlist membership and `From:` domain alignment under the same
 *   allowed root domain.
 * - Returns the exact cryptographically verified header instances (including top-level MIME
 *   headers `signedContentType`, `signedContentDisposition`, `signedContentTransferEncoding`) and
 *   exact verified body bytes so downstream formatting and deduplication never trust unsigned or
 *   prepended duplicate headers.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  decodeRfc2047,
  extractAddress,
  trimAsciiWsp,
} from "../../infra/alchemy/src/mail-forwarder/mime";

const trailingDotPattern = /\.$/;
const updatedPattern = /(^|;)([\r\n \t]*b[\r\n \t]*=)([^;]*)/;
const digitsOnlyPattern = /^\d+$/;
const enotfoundEnodataNxdomainPattern = /\b(?:ENOTFOUND|ENODATA|NXDOMAIN)\b/i;

export interface DnsTxtResolverService {
  readonly resolveTxt: (hostname: string) => Effect.Effect<ReadonlyArray<string>, DnsLookupError>;
}

export class DnsLookupError extends Schema.TaggedError<
  DnsLookupError,
  { readonly brand: unique symbol }
>()("DnsLookupError", {
  hostname: Schema.String,
  reason: Schema.String,
}) {}

export class DnsTxtResolver extends Context.Service<DnsTxtResolver, DnsTxtResolverService>()(
  "kvitbit/scripts/alert-inbox/dkim/DnsTxtResolver",
) {}

export const DnsTxtResolverLive: Layer.Layer<DnsTxtResolver> = Layer.succeed(DnsTxtResolver, {
  resolveTxt: Effect.fn("DnsTxtResolver.resolveTxt")((hostname) =>
    Effect.tryPromise({
      try: () => resolveTxt(hostname),
      catch: (error) =>
        DnsLookupError.make({
          hostname,
          reason: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(Effect.map(Arr.map((chunks) => Arr.join(chunks, "")))),
  ),
});

export interface DkimVerified {
  readonly _tag: "DkimVerified";
  readonly signingDomain: string;
  readonly selector: string;
  readonly algorithm: "rsa-sha256" | "ed25519-sha256";
  readonly fromHeader: string;
  readonly fromAddress: string;
  readonly fromDomain: string;
  readonly matchedAllowedDomain: string;
  readonly signedSubject: string | undefined;
  readonly signedDate: string | undefined;
  readonly signedMessageId: string | undefined;
  readonly signedContentType: string | undefined;
  readonly signedContentDisposition: string | undefined;
  readonly signedContentTransferEncoding: string | undefined;
  readonly verifiedBodyBytes: Uint8Array;
}

interface DkimRejected {
  readonly _tag: "DkimRejected";
  readonly reason: string;
}

interface DkimTransientError {
  readonly _tag: "DkimTransientError";
  readonly reason: string;
}

export type DkimVerificationResult = DkimVerified | DkimRejected | DkimTransientError;

interface RawHeaderField {
  readonly raw: string;
  readonly name: string;
  readonly nameLower: string;
  readonly rawValue: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MIN_RSA_MODULUS_BITS = 1024;
// RFC 6376 §3.2: tag-name = ALPHA *ALNUMPUNC ; ALNUMPUNC = ALPHA / DIGIT / "_"
const RFC6376_TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const normalizeDomain = (domain: string): string =>
  Str.replace(trailingDotPattern, "")(Str.toLowerCase(Str.trim(domain)));

const matchesAllowedDomain = (
  domain: string,
  allowedDomains: ReadonlyArray<string>,
): string | undefined => {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) return undefined;
  for (const rawAllowed of allowedDomains) {
    const allowed = normalizeDomain(rawAllowed);
    if (allowed.length === 0) continue;
    if (normalized === allowed || Str.endsWith(`.${allowed}`)(normalized)) {
      return allowed;
    }
  }
  return undefined;
};

const splitRawMessage = (raw: Uint8Array): { headerRaw: string; bodyBytes: Buffer } => {
  const buf = Buffer.from(raw);
  for (let i = 0; i < buf.length; i += 1) {
    if (
      i + 3 < buf.length &&
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return {
        headerRaw: buf.subarray(0, i).toString("latin1"),
        bodyBytes: buf.subarray(i + 4),
      };
    }
    if (i + 1 < buf.length && buf[i] === 10 && buf[i + 1] === 10) {
      return {
        headerRaw: buf.subarray(0, i).toString("latin1"),
        bodyBytes: buf.subarray(i + 2),
      };
    }
  }
  return {
    headerRaw: buf.toString("latin1"),
    bodyBytes: Buffer.alloc(0),
  };
};

const parseRawHeaderFields = (headerRaw: string): ReadonlyArray<RawHeaderField> => {
  if (headerRaw.length === 0) return [];
  const normalized = Str.replace(/\r?\n/g, "\r\n")(headerRaw);
  const lines = Str.split(normalized, "\r\n");
  const fields: Array<RawHeaderField> = [];
  let current = "";

  const flush = () => {
    if (current.length === 0) return;
    const colon = Option.getOrElse(Str.indexOf(":")(current), () => -1);
    if (colon > 0) {
      const name = Str.slice(0, colon)(current);
      fields.push({
        raw: current,
        name,
        nameLower: Str.toLowerCase(Str.trim(name)),
        rawValue: Str.slice(colon + 1)(current),
      });
    }
    current = "";
  };

  for (const line of lines) {
    if ((Str.startsWith(" ")(line) || Str.startsWith("\t")(line)) && current.length > 0) {
      current += `\r\n${line}`;
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return fields;
};

/**
 * Parses an RFC 6376 §3.2 tag=value list, preserving case-sensitive tag names,
 * validating tag-name grammar (`ALPHA *(ALPHA / DIGIT / "_")`), and rejecting
 * exact duplicate tag names and malformed entries.
 */
export const parseTagList = (raw: string): Map<string, string> | undefined => {
  const tags = new Map<string, string>();
  const parts = Str.split(raw, ";");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    const trimmed = Str.trim(part);
    if (trimmed.length === 0) {
      // A single trailing semicolon is permitted per RFC 6376 §3.2; empty interior entries are invalid.
      if (i === parts.length - 1) continue;
      return undefined;
    }
    const eq = Option.getOrElse(Str.indexOf("=")(trimmed), () => -1);
    if (eq <= 0) return undefined;
    const key = Str.trim(Str.slice(0, eq)(trimmed));
    const value = Str.trim(Str.slice(eq + 1)(trimmed));
    if (!RFC6376_TAG_NAME.test(key) || tags.has(key)) {
      return undefined;
    }
    tags.set(key, value);
  }
  return tags;
};

const stripFws = (value: string): string => Str.replace(/[\r\n \t]+/g, "")(value);

const unfoldHeaderValueUtf8 = (rawValueLatin1: string): string =>
  trimAsciiWsp(
    Str.replace(/\r\n([ \t])/g, "$1")(Buffer.from(rawValueLatin1, "latin1").toString("utf8")),
  );

const canonicalizeBodyImpl = (bodyBytes: Uint8Array, mode: "simple" | "relaxed"): Buffer => {
  const rawStr = Str.replace(/\r?\n/g, "\r\n")(Buffer.from(bodyBytes).toString("latin1"));
  if (mode === "simple") {
    let end = rawStr.length;
    while (
      end >= 2 &&
      Option.getOrElse(Str.charCodeAt(rawStr, end - 2), () => Number.NaN) === 13 &&
      Option.getOrElse(Str.charCodeAt(rawStr, end - 1), () => Number.NaN) === 10
    ) {
      end -= 2;
    }
    if (end === 0) {
      return Buffer.from("\r\n", "latin1");
    }
    return Buffer.from(`${Str.slice(0, end)(rawStr)}\r\n`, "latin1");
  }

  const lines = Str.split(rawStr, "\r\n");
  const canonicalLines = Arr.map(lines, (line) =>
    Str.replace(/[ \t]+/g, " ")(Str.replace(/[ \t]+$/g, "")(line)),
  );
  while (canonicalLines.length > 0 && canonicalLines[canonicalLines.length - 1] === "") {
    canonicalLines.pop();
  }
  if (canonicalLines.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(`${Arr.join(canonicalLines, "\r\n")}\r\n`, "latin1");
};

export const canonicalizeBody: {
  (mode: "simple" | "relaxed"): (bodyBytes: Uint8Array) => Buffer;
  (bodyBytes: Uint8Array, mode: "simple" | "relaxed"): Buffer;
} = Fn.dual(2, canonicalizeBodyImpl);

const canonicalizeHeaderFieldImpl = (field: RawHeaderField, mode: "simple" | "relaxed"): string => {
  if (mode === "simple") {
    return field.raw;
  }
  const name = Str.toLowerCase(Str.trim(field.name));
  const value = Str.replace(
    /^[ \t]+|[ \t]+$/g,
    "",
  )(Str.replace(/[ \t]+/g, " ")(Str.replace(/\r\n[ \t]+/g, " ")(field.rawValue)));
  return `${name}:${value}`;
};

export const canonicalizeHeaderField: {
  (mode: "simple" | "relaxed"): (field: RawHeaderField) => string;
  (field: RawHeaderField, mode: "simple" | "relaxed"): string;
} = Fn.dual(2, canonicalizeHeaderFieldImpl);

const emptyDkimSignatureBTag = (rawHeader: string): string | undefined => {
  const colon = Option.getOrElse(Str.indexOf(":")(rawHeader), () => -1);
  if (colon <= 0) return undefined;
  const namePart = Str.slice(0, colon + 1)(rawHeader);
  const valuePart = Str.slice(colon + 1)(rawHeader);
  // Tag names are case-sensitive per RFC 6376 §3.2.
  if (!updatedPattern.test(valuePart)) return undefined;
  return namePart + Str.replace(updatedPattern, "$1$2")(valuePart);
};

const parseCanonicalization = (
  raw: string | undefined,
): { header: "simple" | "relaxed"; body: "simple" | "relaxed" } | undefined => {
  const value = Str.toLowerCase(Str.trim(raw ?? "simple/simple"));
  const [headerRaw, bodyRaw = "simple"] = Str.split(value, "/");
  if (
    (headerRaw !== "simple" && headerRaw !== "relaxed") ||
    (bodyRaw !== "simple" && bodyRaw !== "relaxed")
  ) {
    return undefined;
  }
  return { header: headerRaw, body: bodyRaw };
};

const parseIdentityDomain = (
  rawI: string | undefined,
  signingDomain: string,
): string | undefined => {
  if (rawI === undefined) return signingDomain;
  const cleaned = stripFws(rawI);
  const atIdx = Option.getOrElse(Str.lastIndexOf("@")(cleaned), () => -1);
  if (atIdx === -1 || atIdx === cleaned.length - 1) return undefined;
  const iDomain = normalizeDomain(Str.slice(atIdx + 1)(cleaned));
  if (iDomain !== signingDomain && !Str.endsWith(`.${signingDomain}`)(iDomain)) {
    return undefined;
  }
  return iDomain;
};

const parsePublicKey = (
  algorithm: "rsa-sha256" | "ed25519-sha256",
  base64Key: string,
): ReturnType<typeof createPublicKey> | undefined => {
  const keyBytes = Buffer.from(stripFws(base64Key), "base64");
  if (keyBytes.length === 0) return undefined;
  try {
    if (algorithm === "ed25519-sha256") {
      const key =
        keyBytes.length === 32
          ? createPublicKey({
              key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
              format: "der",
              type: "spki",
            })
          : createPublicKey({
              key: keyBytes,
              format: "der",
              type: "spki",
            });
      return key.asymmetricKeyType === "ed25519" ? key : undefined;
    }
    const key = createPublicKey({
      key: keyBytes,
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "rsa") return undefined;
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulusLength < MIN_RSA_MODULUS_BITS) return undefined;
    return key;
  } catch {
    return undefined;
  }
};

const verifyAlertDkimImpl = (
  rawBytes: Uint8Array,
  allowedDomains: ReadonlyArray<string>,
): Effect.Effect<DkimVerificationResult, never, DnsTxtResolver> =>
  Effect.gen(function* () {
    const resolver = yield* DnsTxtResolver;
    const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const { headerRaw, bodyBytes } = splitRawMessage(rawBytes);
    const fields = parseRawHeaderFields(headerRaw);

    // Reject duplicate or missing From headers to prevent RFC 6376 header-shadowing attacks.
    const fromHeaders = Arr.filter(fields, (f) => f.nameLower === "from");
    if (fromHeaders.length !== 1) {
      return {
        _tag: "DkimRejected",
        reason:
          fromHeaders.length === 0
            ? "Missing From header"
            : `Ambiguous message with ${fromHeaders.length} From headers`,
      };
    }
    const rawFromUnfolded = unfoldHeaderValueUtf8(fromHeaders[0]?.rawValue ?? "");
    const fromParsed = extractAddress(rawFromUnfolded);
    if (!(fromParsed.address !== undefined && fromParsed.address !== "")) {
      return { _tag: "DkimRejected", reason: "Invalid From address" };
    }
    const atIdx = Option.getOrElse(Str.lastIndexOf("@")(fromParsed.address), () => -1);
    const fromDomain = normalizeDomain(Str.slice(atIdx + 1)(fromParsed.address));
    const fromHeaderDecoded = trimAsciiWsp(decodeRfc2047(rawFromUnfolded));

    const dkimHeaders = Arr.filter(fields, (f) => f.nameLower === "dkim-signature");
    if (dkimHeaders.length === 0) {
      return { _tag: "DkimRejected", reason: "No DKIM-Signature header present" };
    }

    const failureReasons: Array<string> = [];
    const transientReasons: Array<string> = [];

    for (const dkimField of dkimHeaders) {
      const tags = parseTagList(dkimField.rawValue);
      if (!(tags !== undefined)) {
        failureReasons.push("Malformed DKIM-Signature tag list or duplicate tag");
        continue;
      }
      if (tags.get("v") !== "1") {
        failureReasons.push("Unsupported DKIM version");
        continue;
      }
      if (tags.has("l")) {
        failureReasons.push("Rejected DKIM body-length tag (l=)");
        continue;
      }
      const algRaw: string = Str.toLowerCase(Str.trim(tags.get("a") ?? ""));
      if (algRaw !== "rsa-sha256" && algRaw !== "ed25519-sha256") {
        failureReasons.push(`Unsupported DKIM algorithm '${algRaw || "missing"}'`);
        continue;
      }
      const algorithm: "rsa-sha256" | "ed25519-sha256" = algRaw;

      const signingDomain = normalizeDomain(tags.get("d") ?? "");
      const selector = stripFws(tags.get("s") ?? "");
      const signedHeadersRaw = tags.get("h") ?? "";
      const bhRaw = stripFws(tags.get("bh") ?? "");
      const bRaw = stripFws(tags.get("b") ?? "");
      if (
        !(
          signingDomain !== "" &&
          selector !== "" &&
          signedHeadersRaw !== "" &&
          bhRaw !== "" &&
          bRaw !== ""
        )
      ) {
        failureReasons.push("DKIM-Signature missing required tag(s)");
        continue;
      }

      const identityDomain = parseIdentityDomain(tags.get("i"), signingDomain);
      if (!(identityDomain !== undefined && identityDomain !== "")) {
        failureReasons.push("Invalid DKIM identity tag (i=)");
        continue;
      }

      const matchedAllowed = matchesAllowedDomain(signingDomain, allowedDomains);
      if (!(matchedAllowed !== undefined && matchedAllowed !== "")) {
        failureReasons.push(`Signing domain '${signingDomain}' is not in allowlist`);
        continue;
      }
      if (fromDomain !== matchedAllowed && !Str.endsWith(`.${matchedAllowed}`)(fromDomain)) {
        failureReasons.push(
          `From domain '${fromDomain}' does not align with allowed domain '${matchedAllowed}'`,
        );
        continue;
      }

      const xRaw = tags.get("x");
      if (xRaw !== undefined) {
        if (!digitsOnlyPattern.test(Str.trim(xRaw))) {
          failureReasons.push("Invalid DKIM expiration tag (x=)");
          continue;
        }
        const expiresAt = Number.parseInt(Str.trim(xRaw), 10);
        if (nowSec > expiresAt) {
          failureReasons.push("DKIM signature expired");
          continue;
        }
      }

      const tRaw = tags.get("t");
      if (tRaw !== undefined) {
        if (!digitsOnlyPattern.test(Str.trim(tRaw))) {
          failureReasons.push("Invalid DKIM timestamp tag (t=)");
          continue;
        }
        if (
          xRaw !== undefined &&
          Number.parseInt(Str.trim(tRaw), 10) >= Number.parseInt(Str.trim(xRaw), 10)
        ) {
          failureReasons.push("DKIM timestamp t= >= x=");
          continue;
        }
      }

      const canon = parseCanonicalization(tags.get("c"));
      if (!(canon !== undefined)) {
        failureReasons.push(`Unsupported DKIM canonicalization '${tags.get("c") ?? ""}'`);
        continue;
      }

      const signedHeaderNames = Arr.filter(
        Arr.map(Str.split(signedHeadersRaw, ":"), (h) => Str.toLowerCase(Str.trim(h))),
        (h) => h.length > 0,
      );
      if (!signedHeaderNames.includes("from")) {
        failureReasons.push("DKIM h= does not sign From header");
        continue;
      }

      // 1. Verify body hash (bh=)
      const canonicalBody = canonicalizeBody(bodyBytes, canon.body);
      const computedBh = createHash("sha256").update(canonicalBody).digest();
      const expectedBh = Buffer.from(bhRaw, "base64");
      if (computedBh.length !== expectedBh.length || !timingSafeEqual(computedBh, expectedBh)) {
        failureReasons.push(`Body hash mismatch for d=${signingDomain}`);
        continue;
      }

      // 2. Construct canonicalized signed headers bottom-to-top per RFC 6376 §5.4.2,
      // capturing the exact verified header instances for downstream formatting & dedup.
      const usedIndices = new Set<number>();
      const signedLines: Array<string> = [];
      const verifiedHeaderValues = new Map<string, Array<string>>();
      for (const targetName of signedHeaderNames) {
        for (let idx = fields.length - 1; idx >= 0; idx -= 1) {
          if (usedIndices.has(idx)) continue;
          const candidate = fields[idx];
          if (candidate !== undefined && candidate.nameLower === targetName) {
            usedIndices.add(idx);
            signedLines.push(`${canonicalizeHeaderField(candidate, canon.header)}\r\n`);
            const list = verifiedHeaderValues.get(targetName) ?? [];
            list.push(unfoldHeaderValueUtf8(candidate.rawValue));
            verifiedHeaderValues.set(targetName, list);
            break;
          }
        }
      }

      const strippedDkimRaw = emptyDkimSignatureBTag(dkimField.raw);
      if (!(strippedDkimRaw !== undefined && strippedDkimRaw !== "")) {
        failureReasons.push("Unable to strip b= from DKIM-Signature header");
        continue;
      }
      const strippedColon = Option.getOrElse(Str.indexOf(":")(strippedDkimRaw), () => -1);
      const strippedDkimField: RawHeaderField = {
        raw: strippedDkimRaw,
        name: Str.slice(0, strippedColon)(strippedDkimRaw),
        nameLower: "dkim-signature",
        rawValue: Str.slice(strippedColon + 1)(strippedDkimRaw),
      };
      // Per RFC 6376 §3.7, the DKIM-Signature header itself has NO trailing CRLF.
      const signingInput = Buffer.from(
        Arr.join(signedLines, "") + canonicalizeHeaderField(strippedDkimField, canon.header),
        "latin1",
      );

      // 3. Resolve DNS public key record and verify cryptographic signature
      const dnsHost = `${selector}._domainkey.${signingDomain}`;
      const txtResult = yield* Effect.result(resolver.resolveTxt(dnsHost));
      if (txtResult._tag === "Failure") {
        const msg = `DNS lookup failed for ${dnsHost}: ${txtResult.failure.reason}`;
        if (enotfoundEnodataNxdomainPattern.test(txtResult.failure.reason)) {
          failureReasons.push(msg);
        } else {
          transientReasons.push(msg);
        }
        continue;
      }

      const sigBytes = Buffer.from(bRaw, "base64");
      let matched = false;
      for (const txt of txtResult.success) {
        const keyTags = parseTagList(txt);
        if (!(keyTags !== undefined)) {
          failureReasons.push(`Malformed DKIM DNS key record at ${dnsHost}`);
          continue;
        }
        const keyVersion = keyTags.get("v");
        if (keyVersion !== undefined) {
          // RFC 6376 §3.6.1: If `v=` is present in a DKIM key record, it MUST be the first tag
          // and MUST equal "DKIM1".
          const firstTagName = keyTags.keys().next().value;
          if (firstTagName !== "v" || keyVersion !== "DKIM1") {
            failureReasons.push(`Invalid DKIM key version tag at ${dnsHost}`);
            continue;
          }
        }
        const keyType = Str.toLowerCase(Str.trim(keyTags.get("k") ?? "rsa"));
        if (
          (algorithm === "rsa-sha256" && keyType !== "rsa") ||
          (algorithm === "ed25519-sha256" && keyType !== "ed25519")
        ) {
          continue;
        }
        // RFC 6376 §3.6.1 service type restriction (`s=` defaults to `*`)
        const serviceTypes = Arr.filter(
          Arr.map(Str.split(keyTags.get("s") ?? "*", ":"), (s) => Str.toLowerCase(Str.trim(s))),
          (s) => s.length > 0,
        );
        if (!(serviceTypes.includes("*") || serviceTypes.includes("email"))) {
          failureReasons.push(`DKIM key at ${dnsHost} is not permitted for email service`);
          continue;
        }
        const allowedHashes = keyTags.get("h");
        if (
          allowedHashes !== undefined &&
          !Arr.map(Str.split(allowedHashes, ":"), (h) => Str.toLowerCase(Str.trim(h))).includes(
            "sha256",
          )
        ) {
          continue;
        }
        // RFC 6376 §3.6.1 `t=s` requires the identity domain (`i=`) to equal `d=` exactly.
        const keyFlags = Arr.map(Str.split(keyTags.get("t") ?? "", ":"), (flag) =>
          Str.toLowerCase(Str.trim(flag)),
        );
        if (keyFlags.includes("s") && identityDomain !== signingDomain) {
          failureReasons.push(
            `Key t=s requires strict identity alignment (${identityDomain} != ${signingDomain})`,
          );
          continue;
        }
        const keyBase64 = keyTags.get("p") ?? "";
        if (stripFws(keyBase64).length === 0) {
          failureReasons.push(`DKIM key revoked at ${dnsHost}`);
          continue;
        }
        const pubKey = parsePublicKey(algorithm, keyBase64);
        if (!(pubKey !== undefined)) {
          failureReasons.push(`Invalid or too-weak DKIM public key at ${dnsHost}`);
          continue;
        }
        // RFC 8463 §3.3: Ed25519-SHA256 verifies the SHA-256 digest of the canonicalized signing input.
        const ok =
          algorithm === "ed25519-sha256"
            ? verifySignature(
                null,
                createHash("sha256").update(signingInput).digest(),
                pubKey,
                sigBytes,
              )
            : verifySignature("sha256", signingInput, pubKey, sigBytes);
        if (ok) {
          matched = true;
          break;
        }
      }

      if (matched) {
        const rawSignedSubject = verifiedHeaderValues.get("subject")?.[0];
        const rawSignedDate = verifiedHeaderValues.get("date")?.[0];
        const rawSignedMessageId = verifiedHeaderValues.get("message-id")?.[0];
        const rawSignedContentType = verifiedHeaderValues.get("content-type")?.[0];
        const rawSignedContentDisposition = verifiedHeaderValues.get("content-disposition")?.[0];
        const rawSignedContentTransferEncoding = verifiedHeaderValues.get(
          "content-transfer-encoding",
        )?.[0];
        return {
          _tag: "DkimVerified",
          signingDomain,
          selector,
          algorithm,
          fromHeader: fromHeaderDecoded,
          fromAddress: fromParsed.address,
          fromDomain,
          matchedAllowedDomain: matchedAllowed,
          signedSubject:
            rawSignedSubject !== undefined
              ? trimAsciiWsp(decodeRfc2047(rawSignedSubject))
              : undefined,
          signedDate: rawSignedDate !== undefined ? trimAsciiWsp(rawSignedDate) : undefined,
          signedMessageId:
            rawSignedMessageId !== undefined ? trimAsciiWsp(rawSignedMessageId) : undefined,
          signedContentType:
            rawSignedContentType !== undefined ? trimAsciiWsp(rawSignedContentType) : undefined,
          signedContentDisposition:
            rawSignedContentDisposition !== undefined
              ? trimAsciiWsp(rawSignedContentDisposition)
              : undefined,
          signedContentTransferEncoding:
            rawSignedContentTransferEncoding !== undefined
              ? trimAsciiWsp(rawSignedContentTransferEncoding)
              : undefined,
          verifiedBodyBytes: Uint8Array.from(bodyBytes),
        };
      }
      failureReasons.push(`Cryptographic signature verification failed for ${dnsHost}`);
    }

    if (transientReasons.length > 0) {
      return {
        _tag: "DkimTransientError",
        reason: Arr.join(transientReasons, "; "),
      };
    }

    return {
      _tag: "DkimRejected",
      reason: Arr.join(failureReasons, "; ") || "No valid allowlisted DKIM signature found",
    };
  });

export const verifyAlertDkim: {
  (
    allowedDomains: ReadonlyArray<string>,
  ): (rawBytes: Uint8Array) => Effect.Effect<DkimVerificationResult, never, DnsTxtResolver>;
  (
    rawBytes: Uint8Array,
    allowedDomains: ReadonlyArray<string>,
  ): Effect.Effect<DkimVerificationResult, never, DnsTxtResolver>;
} = Fn.dual(2, verifyAlertDkimImpl);
