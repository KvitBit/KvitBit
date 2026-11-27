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
import { Clock, Context, Data, Effect, Layer } from "effect";
import {
  decodeRfc2047,
  extractAddress,
  trimAsciiWsp,
} from "../../infra/alchemy/src/mail-forwarder/mime";

export interface DnsTxtResolverService {
  readonly resolveTxt: (hostname: string) => Effect.Effect<ReadonlyArray<string>, DnsLookupError>;
}

export class DnsLookupError extends Data.TaggedError("DnsLookupError")<{
  readonly hostname: string;
  readonly reason: string;
}> {}

export class DnsTxtResolver extends Context.Service<DnsTxtResolver, DnsTxtResolverService>()(
  "KvitbitAlertDnsTxtResolver",
) {}

export const DnsTxtResolverLive: Layer.Layer<DnsTxtResolver> = Layer.succeed(DnsTxtResolver, {
  resolveTxt: (hostname) =>
    Effect.tryPromise({
      try: async () => {
        const records = await resolveTxt(hostname);
        return records.map((chunks) => chunks.join(""));
      },
      catch: (error) =>
        new DnsLookupError({
          hostname,
          reason: error instanceof Error ? error.message : String(error),
        }),
    }),
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

export interface DkimRejected {
  readonly _tag: "DkimRejected";
  readonly reason: string;
}

export interface DkimTransientError {
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

const normalizeDomain = (domain: string): string => domain.trim().toLowerCase().replace(/\.$/, "");

const matchesAllowedDomain = (
  domain: string,
  allowedDomains: ReadonlyArray<string>,
): string | undefined => {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) return undefined;
  for (const rawAllowed of allowedDomains) {
    const allowed = normalizeDomain(rawAllowed);
    if (allowed.length === 0) continue;
    if (normalized === allowed || normalized.endsWith(`.${allowed}`)) {
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
  const normalized = headerRaw.replace(/\r?\n/g, "\r\n");
  const lines = normalized.split("\r\n");
  const fields: Array<RawHeaderField> = [];
  let current = "";

  const flush = () => {
    if (current.length === 0) return;
    const colon = current.indexOf(":");
    if (colon > 0) {
      const name = current.slice(0, colon);
      fields.push({
        raw: current,
        name,
        nameLower: name.trim().toLowerCase(),
        rawValue: current.slice(colon + 1),
      });
    }
    current = "";
  };

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && current.length > 0) {
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
  const parts = raw.split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      // A single trailing semicolon is permitted per RFC 6376 §3.2; empty interior entries are invalid.
      if (i === parts.length - 1) continue;
      return undefined;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return undefined;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!RFC6376_TAG_NAME.test(key) || tags.has(key)) {
      return undefined;
    }
    tags.set(key, value);
  }
  return tags;
};

const stripFws = (value: string): string => value.replace(/[\r\n \t]+/g, "");

const unfoldHeaderValueUtf8 = (rawValueLatin1: string): string =>
  trimAsciiWsp(
    Buffer.from(rawValueLatin1, "latin1")
      .toString("utf8")
      .replace(/\r\n([ \t])/g, "$1"),
  );

export const canonicalizeBody = (bodyBytes: Uint8Array, mode: "simple" | "relaxed"): Buffer => {
  const rawStr = Buffer.from(bodyBytes).toString("latin1").replace(/\r?\n/g, "\r\n");
  if (mode === "simple") {
    let end = rawStr.length;
    while (end >= 2 && rawStr.charCodeAt(end - 2) === 13 && rawStr.charCodeAt(end - 1) === 10) {
      end -= 2;
    }
    if (end === 0) {
      return Buffer.from("\r\n", "latin1");
    }
    return Buffer.from(`${rawStr.slice(0, end)}\r\n`, "latin1");
  }

  const lines = rawStr.split("\r\n");
  const canonicalLines = lines.map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]+/g, " "));
  while (canonicalLines.length > 0 && canonicalLines[canonicalLines.length - 1] === "") {
    canonicalLines.pop();
  }
  if (canonicalLines.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(`${canonicalLines.join("\r\n")}\r\n`, "latin1");
};

export const canonicalizeHeaderField = (
  field: RawHeaderField,
  mode: "simple" | "relaxed",
): string => {
  if (mode === "simple") {
    return field.raw;
  }
  const name = field.name.trim().toLowerCase();
  const value = field.rawValue
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+|[ \t]+$/g, "");
  return `${name}:${value}`;
};

const emptyDkimSignatureBTag = (rawHeader: string): string | undefined => {
  const colon = rawHeader.indexOf(":");
  if (colon <= 0) return undefined;
  const namePart = rawHeader.slice(0, colon + 1);
  const valuePart = rawHeader.slice(colon + 1);
  let replaced = false;
  // Tag names are case-sensitive per RFC 6376 §3.2: strip only lowercase `b=`, not extension `B=`.
  const updated = valuePart.replace(
    /(^|;)([\r\n \t]*b[\r\n \t]*=)([^;]*)/,
    (_match, sep: string, prefix: string) => {
      replaced = true;
      return `${sep}${prefix}`;
    },
  );
  return replaced ? `${namePart}${updated}` : undefined;
};

const parseCanonicalization = (
  raw: string | undefined,
): { header: "simple" | "relaxed"; body: "simple" | "relaxed" } | undefined => {
  const value = (raw ?? "simple/simple").trim().toLowerCase();
  const [headerRaw, bodyRaw = "simple"] = value.split("/");
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
  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx === -1 || atIdx === cleaned.length - 1) return undefined;
  const iDomain = normalizeDomain(cleaned.slice(atIdx + 1));
  if (iDomain !== signingDomain && !iDomain.endsWith(`.${signingDomain}`)) {
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

export const verifyAlertDkim = (
  rawBytes: Uint8Array,
  allowedDomains: ReadonlyArray<string>,
): Effect.Effect<DkimVerificationResult, never, DnsTxtResolver> =>
  Effect.gen(function* () {
    const resolver = yield* DnsTxtResolver;
    const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const { headerRaw, bodyBytes } = splitRawMessage(rawBytes);
    const fields = parseRawHeaderFields(headerRaw);

    // Reject duplicate or missing From headers to prevent RFC 6376 header-shadowing attacks.
    const fromHeaders = fields.filter((f) => f.nameLower === "from");
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
    if (!fromParsed.address) {
      return { _tag: "DkimRejected", reason: "Invalid From address" };
    }
    const atIdx = fromParsed.address.lastIndexOf("@");
    const fromDomain = normalizeDomain(fromParsed.address.slice(atIdx + 1));
    const fromHeaderDecoded = trimAsciiWsp(decodeRfc2047(rawFromUnfolded));

    const dkimHeaders = fields.filter((f) => f.nameLower === "dkim-signature");
    if (dkimHeaders.length === 0) {
      return { _tag: "DkimRejected", reason: "No DKIM-Signature header present" };
    }

    const failureReasons: Array<string> = [];
    const transientReasons: Array<string> = [];

    for (const dkimField of dkimHeaders) {
      const tags = parseTagList(dkimField.rawValue);
      if (!tags) {
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
      const algRaw = (tags.get("a") ?? "").trim().toLowerCase();
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
      if (!signingDomain || !selector || !signedHeadersRaw || !bhRaw || !bRaw) {
        failureReasons.push("DKIM-Signature missing required tag(s)");
        continue;
      }

      const identityDomain = parseIdentityDomain(tags.get("i"), signingDomain);
      if (!identityDomain) {
        failureReasons.push("Invalid DKIM identity tag (i=)");
        continue;
      }

      const matchedAllowed = matchesAllowedDomain(signingDomain, allowedDomains);
      if (!matchedAllowed) {
        failureReasons.push(`Signing domain '${signingDomain}' is not in allowlist`);
        continue;
      }
      if (fromDomain !== matchedAllowed && !fromDomain.endsWith(`.${matchedAllowed}`)) {
        failureReasons.push(
          `From domain '${fromDomain}' does not align with allowed domain '${matchedAllowed}'`,
        );
        continue;
      }

      const xRaw = tags.get("x");
      if (xRaw !== undefined) {
        if (!/^\d+$/.test(xRaw.trim())) {
          failureReasons.push("Invalid DKIM expiration tag (x=)");
          continue;
        }
        const expiresAt = Number.parseInt(xRaw.trim(), 10);
        if (nowSec > expiresAt) {
          failureReasons.push("DKIM signature expired");
          continue;
        }
      }

      const tRaw = tags.get("t");
      if (tRaw !== undefined) {
        if (!/^\d+$/.test(tRaw.trim())) {
          failureReasons.push("Invalid DKIM timestamp tag (t=)");
          continue;
        }
        if (
          xRaw !== undefined &&
          Number.parseInt(tRaw.trim(), 10) >= Number.parseInt(xRaw.trim(), 10)
        ) {
          failureReasons.push("DKIM timestamp t= >= x=");
          continue;
        }
      }

      const canon = parseCanonicalization(tags.get("c"));
      if (!canon) {
        failureReasons.push(`Unsupported DKIM canonicalization '${tags.get("c") ?? ""}'`);
        continue;
      }

      const signedHeaderNames = signedHeadersRaw
        .split(":")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0);
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
          if (candidate && candidate.nameLower === targetName) {
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
      if (!strippedDkimRaw) {
        failureReasons.push("Unable to strip b= from DKIM-Signature header");
        continue;
      }
      const strippedColon = strippedDkimRaw.indexOf(":");
      const strippedDkimField: RawHeaderField = {
        raw: strippedDkimRaw,
        name: strippedDkimRaw.slice(0, strippedColon),
        nameLower: "dkim-signature",
        rawValue: strippedDkimRaw.slice(strippedColon + 1),
      };
      // Per RFC 6376 §3.7, the DKIM-Signature header itself has NO trailing CRLF.
      const signingInput = Buffer.from(
        signedLines.join("") + canonicalizeHeaderField(strippedDkimField, canon.header),
        "latin1",
      );

      // 3. Resolve DNS public key record and verify cryptographic signature
      const dnsHost = `${selector}._domainkey.${signingDomain}`;
      const txtResult = yield* Effect.result(resolver.resolveTxt(dnsHost));
      if (txtResult._tag === "Failure") {
        const msg = `DNS lookup failed for ${dnsHost}: ${txtResult.failure.reason}`;
        if (/\b(?:ENOTFOUND|ENODATA|NXDOMAIN)\b/i.test(txtResult.failure.reason)) {
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
        if (!keyTags) {
          failureReasons.push(`Malformed DKIM DNS key record at ${dnsHost}`);
          continue;
        }
        const keyVersion = keyTags.get("v");
        if (keyVersion !== undefined && keyVersion !== "DKIM1") continue;
        const keyType = (keyTags.get("k") ?? "rsa").trim().toLowerCase();
        if (
          (algorithm === "rsa-sha256" && keyType !== "rsa") ||
          (algorithm === "ed25519-sha256" && keyType !== "ed25519")
        ) {
          continue;
        }
        // RFC 6376 §3.6.1 service type restriction (`s=` defaults to `*`)
        const serviceTypes = (keyTags.get("s") ?? "*")
          .split(":")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
        if (!serviceTypes.includes("*") && !serviceTypes.includes("email")) {
          failureReasons.push(`DKIM key at ${dnsHost} is not permitted for email service`);
          continue;
        }
        const allowedHashes = keyTags.get("h");
        if (
          allowedHashes !== undefined &&
          !allowedHashes
            .split(":")
            .map((h) => h.trim().toLowerCase())
            .includes("sha256")
        ) {
          continue;
        }
        // RFC 6376 §3.6.1 `t=s` requires the identity domain (`i=`) to equal `d=` exactly.
        const keyFlags = (keyTags.get("t") ?? "")
          .split(":")
          .map((flag) => flag.trim().toLowerCase());
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
        if (!pubKey) {
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
        reason: transientReasons.join("; "),
      };
    }

    return {
      _tag: "DkimRejected",
      reason: failureReasons.join("; ") || "No valid allowlisted DKIM signature found",
    };
  });
