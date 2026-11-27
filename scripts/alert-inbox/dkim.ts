/**
 * RFC 6376 cryptographic DKIM verifier for programmatic alert email ingestion.
 *
 * Security invariants:
 * - Verifies raw RFC 5322 wire bytes directly (RSA-SHA256 and Ed25519-SHA256 only; rejects SHA-1).
 * - Rejects `l=` body-length tags (prevents trailing spoofed body content).
 * - Rejects messages with missing or duplicate `From:` headers (prevents header-shadowing attacks).
 * - Requires `from` in the signed header list (`h=`) and enforces expiration (`x=`).
 * - Enforces both signing-domain (`d=`) allowlist membership AND `From:` domain alignment
 *   under the same allowed root domain (plus strict equality when DNS key specifies `t=s`).
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { extractAddress } from "../../infra/alchemy/src/mail-forwarder/mime";

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
  readonly fromAddress: string;
  readonly fromDomain: string;
  readonly matchedAllowedDomain: string;
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

const parseTagList = (raw: string): Map<string, string> => {
  const tags = new Map<string, string>();
  const parts = raw.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key.length > 0 && !tags.has(key)) {
      tags.set(key, value);
    }
  }
  return tags;
};

const stripFws = (value: string): string => value.replace(/[\r\n \t]+/g, "");

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
  const updated = valuePart.replace(
    /(^|;)([\r\n \t]*b[\r\n \t]*=)([^;]*)/i,
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

const parsePublicKey = (
  algorithm: "rsa-sha256" | "ed25519-sha256",
  base64Key: string,
): ReturnType<typeof createPublicKey> | undefined => {
  const keyBytes = Buffer.from(stripFws(base64Key), "base64");
  if (keyBytes.length === 0) return undefined;
  try {
    if (algorithm === "ed25519-sha256" && keyBytes.length === 32) {
      return createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
        format: "der",
        type: "spki",
      });
    }
    return createPublicKey({
      key: keyBytes,
      format: "der",
      type: "spki",
    });
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
    const rawFromUtf8 = Buffer.from(fromHeaders[0]?.rawValue ?? "", "latin1")
      .toString("utf8")
      .replace(/\r\n[ \t]+/g, " ")
      .trim();
    const fromParsed = extractAddress(rawFromUtf8);
    if (!fromParsed.address) {
      return { _tag: "DkimRejected", reason: "Invalid From address" };
    }
    const atIdx = fromParsed.address.lastIndexOf("@");
    const fromDomain = normalizeDomain(fromParsed.address.slice(atIdx + 1));

    const dkimHeaders = fields.filter((f) => f.nameLower === "dkim-signature");
    if (dkimHeaders.length === 0) {
      return { _tag: "DkimRejected", reason: "No DKIM-Signature header present" };
    }

    const failureReasons: Array<string> = [];
    const transientReasons: Array<string> = [];

    for (const dkimField of dkimHeaders) {
      const tags = parseTagList(dkimField.rawValue);
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

      // 2. Construct canonicalized signed headers (bottom-to-top per RFC 6376 §5.4.2)
      const usedIndices = new Set<number>();
      const signedLines: Array<string> = [];
      for (const targetName of signedHeaderNames) {
        for (let idx = fields.length - 1; idx >= 0; idx -= 1) {
          if (usedIndices.has(idx)) continue;
          const candidate = fields[idx];
          if (candidate && candidate.nameLower === targetName) {
            usedIndices.add(idx);
            signedLines.push(`${canonicalizeHeaderField(candidate, canon.header)}\r\n`);
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
        const keyVersion = keyTags.get("v");
        if (keyVersion !== undefined && keyVersion !== "DKIM1") continue;
        const keyType = (keyTags.get("k") ?? "rsa").trim().toLowerCase();
        if (
          (algorithm === "rsa-sha256" && keyType !== "rsa") ||
          (algorithm === "ed25519-sha256" && keyType !== "ed25519")
        ) {
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
        const keyFlags = (keyTags.get("t") ?? "")
          .split(":")
          .map((flag) => flag.trim().toLowerCase());
        if (keyFlags.includes("s") && fromDomain !== signingDomain) {
          failureReasons.push(
            `Key t=s requires strict domain alignment (${fromDomain} != ${signingDomain})`,
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
          failureReasons.push(`Invalid DKIM public key at ${dnsHost}`);
          continue;
        }
        const ok =
          algorithm === "ed25519-sha256"
            ? verifySignature(null, signingInput, pubKey, sigBytes)
            : verifySignature("sha256", signingInput, pubKey, sigBytes);
        if (ok) {
          matched = true;
          break;
        }
      }

      if (matched) {
        return {
          _tag: "DkimVerified",
          signingDomain,
          selector,
          algorithm,
          fromAddress: fromParsed.address,
          fromDomain,
          matchedAllowedDomain: matchedAllowed,
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
