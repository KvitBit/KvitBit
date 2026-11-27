import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  canonicalizeBody,
  canonicalizeHeaderField,
  DnsLookupError,
  DnsTxtResolver,
  parseTagList,
  verifyAlertDkim,
} from "./dkim";
import { ALERT_ISSUE_LABEL, alertIssueMarker, formatAlertIssue, redactAlertText } from "./issue";
import {
  AlertBucket,
  AlertInboxError,
  AlertIssueTracker,
  makeGcloudAlertBucket,
  makeGhAlertIssueTracker,
  runAlertInboxPass,
} from "./service";
import { openAlertInboxStore } from "./store";

interface SignedEmailFixture {
  readonly raw: Uint8Array;
  readonly dnsRecords: Record<string, ReadonlyArray<string>>;
}

const buildDkimSignedMessage = (params: {
  readonly algorithm: "rsa-sha256" | "ed25519-sha256";
  readonly signingDomain: string;
  readonly selector: string;
  readonly fromHeader: string;
  readonly subject?: string;
  readonly messageId?: string;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly contentTransferEncoding?: string;
  readonly body: string;
  readonly canon?: "relaxed/relaxed" | "simple/simple";
  readonly prependHeaders?: ReadonlyArray<string>;
  readonly extraHeaders?: ReadonlyArray<string>;
  readonly signedHeaderNames?: ReadonlyArray<string>;
  readonly extraDkimTags?: string;
  readonly keyFlags?: string;
  readonly keyService?: string;
  readonly keyRevoked?: boolean;
  readonly rsaModulusLength?: number;
  readonly tamperBodyAfterSign?: string;
}): SignedEmailFixture => {
  const canon = params.canon ?? "relaxed/relaxed";
  const [headerCanon, bodyCanon] = canon.split("/") as ["relaxed" | "simple", "relaxed" | "simple"];

  let privateKey: KeyObject;
  let pubKeyBase64: string;
  let keyType: "rsa" | "ed25519";

  if (params.algorithm === "rsa-sha256") {
    const pair = generateKeyPairSync("rsa", { modulusLength: params.rsaModulusLength ?? 2048 });
    privateKey = pair.privateKey;
    pubKeyBase64 = (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
      "base64",
    );
    keyType = "rsa";
  } else {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    // RFC 8463 Ed25519 DNS `p=` holds the raw 32-byte public key.
    pubKeyBase64 = spki.subarray(spki.length - 32).toString("base64");
    keyType = "ed25519";
  }

  const baseHeaders = [
    `From: ${params.fromHeader}`,
    "To: alerts@kvitbit.com",
    ...(params.subject !== undefined ? [`Subject: ${params.subject}`] : []),
    "Date: Fri, 27 Nov 2026 21:00:00 +0000",
    ...(params.messageId ? [`Message-ID: ${params.messageId}`] : []),
    `Content-Type: ${params.contentType ?? 'text/plain; charset="utf-8"'}`,
    ...(params.contentDisposition ? [`Content-Disposition: ${params.contentDisposition}`] : []),
    ...(params.contentTransferEncoding
      ? [`Content-Transfer-Encoding: ${params.contentTransferEncoding}`]
      : []),
    ...(params.extraHeaders ?? []),
  ];

  const signedNames = params.signedHeaderNames ?? [
    "from",
    "to",
    ...(params.subject !== undefined ? ["subject"] : []),
    "date",
    ...(params.messageId ? ["message-id"] : []),
    "content-type",
    ...(params.contentDisposition ? ["content-disposition"] : []),
    ...(params.contentTransferEncoding ? ["content-transfer-encoding"] : []),
  ];
  const bodyBuf = Buffer.from(params.body, "utf8");
  const bh = createHash("sha256").update(canonicalizeBody(bodyBuf, bodyCanon)).digest("base64");

  const dkimHeaderPrefix =
    `DKIM-Signature: v=1; a=${params.algorithm}; c=${canon}; d=${params.signingDomain}; ` +
    `s=${params.selector}; h=${signedNames.join(":")}; bh=${bh}; ` +
    `${params.extraDkimTags ? `${params.extraDkimTags}; ` : ""}b=`;

  const parsedFields = baseHeaders.map((raw) => {
    const colon = raw.indexOf(":");
    const name = raw.slice(0, colon);
    return {
      raw,
      name,
      nameLower: name.trim().toLowerCase(),
      rawValue: raw.slice(colon + 1),
    };
  });

  const used = new Set<number>();
  const signedLines: Array<string> = [];
  for (const targetName of signedNames) {
    for (let idx = parsedFields.length - 1; idx >= 0; idx -= 1) {
      if (used.has(idx)) continue;
      const f = parsedFields[idx];
      if (f && f.nameLower === targetName.toLowerCase()) {
        used.add(idx);
        signedLines.push(`${canonicalizeHeaderField(f, headerCanon)}\r\n`);
        break;
      }
    }
  }

  const dkimColon = dkimHeaderPrefix.indexOf(":");
  const canonicalDkim = canonicalizeHeaderField(
    {
      raw: dkimHeaderPrefix,
      name: dkimHeaderPrefix.slice(0, dkimColon),
      nameLower: "dkim-signature",
      rawValue: dkimHeaderPrefix.slice(dkimColon + 1),
    },
    headerCanon,
  );
  const signingInput = Buffer.from(signedLines.join("") + canonicalDkim, "latin1");
  // RFC 8463 §3.3: Ed25519-SHA256 signs the SHA-256 digest of the canonicalized signing input.
  const sig =
    params.algorithm === "ed25519-sha256"
      ? sign(null, createHash("sha256").update(signingInput).digest(), privateKey)
      : sign("sha256", signingInput, privateKey);

  const dkimHeader = `${dkimHeaderPrefix}${sig.toString("base64")}`;
  const finalBody = params.tamperBodyAfterSign ?? params.body;
  const allHeaders = [...(params.prependHeaders ?? []), dkimHeader, ...baseHeaders];
  const rawMessage = `${allHeaders.join("\r\n")}\r\n\r\n${finalBody}`;

  const dnsTxt =
    `v=DKIM1; k=${keyType}; ` +
    `${params.keyService ? `s=${params.keyService}; ` : ""}` +
    `${params.keyFlags ? `t=${params.keyFlags}; ` : ""}` +
    `p=${params.keyRevoked ? "" : pubKeyBase64}`;

  return {
    raw: Buffer.from(rawMessage, "utf8"),
    dnsRecords: {
      [`${params.selector}._domainkey.${params.signingDomain}`]: [dnsTxt],
    },
  };
};

const mockDnsLayer = (
  records: Record<string, ReadonlyArray<string> | string>,
): Layer.Layer<DnsTxtResolver> =>
  Layer.succeed(DnsTxtResolver, {
    resolveTxt: (hostname) => {
      const entry = records[hostname];
      if (entry === undefined) {
        return Effect.fail(new DnsLookupError({ hostname, reason: "ENOTFOUND" }));
      }
      if (typeof entry === "string") {
        return Effect.fail(new DnsLookupError({ hostname, reason: entry }));
      }
      return Effect.succeed(entry);
    },
  });

// Published RFC 8463 Appendix A test vector (both RSA-SHA256 and Ed25519-SHA256 signatures).
const RFC_8463_APPENDIX_A_MESSAGE = Buffer.from(
  [
    "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;",
    " d=football.example.com; i=@football.example.com;",
    " q=dns/txt; s=brisbane; t=1528637909; h=from : to :",
    " subject : date : message-id : from : subject : date;",
    " bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;",
    " b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus",
    " Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==",
    "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;",
    " d=football.example.com; i=@football.example.com;",
    " q=dns/txt; s=test; t=1528637909; h=from : to : subject :",
    " date : message-id : from : subject : date;",
    " bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;",
    " b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3",
    " DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz",
    " dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=",
    "From: Joe SixPack <joe@football.example.com>",
    "To: Suzie Q <suzie@shopping.example.net>",
    "Subject: Is dinner ready?",
    "Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)",
    "Message-ID: <20030712040037.46341.5F8J@football.example.com>",
    "",
    "Hi.",
    "",
    "We lost the game.  Are you hungry yet?",
    "",
    "Joe.",
    "",
  ].join("\r\n"),
  "utf8",
);

const RFC_8463_ED25519_TXT = "v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const RFC_8463_RSA_TXT =
  "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR" +
  "iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC" +
  "DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3" +
  "Ip3G+2kryOTIKT+l/K4w3QIDAQAB";

describe("RFC 6376 / RFC 8301 / RFC 8463 DKIM verifier", () => {
  test("interoperates independently with BOTH RSA-SHA256 and Ed25519-SHA256 on published RFC 8463 Appendix A vector and allows case-distinct extension tags like V=custom", async () => {
    const edOnly = await Effect.runPromise(
      verifyAlertDkim(RFC_8463_APPENDIX_A_MESSAGE, ["example.com"]).pipe(
        Effect.provide(
          mockDnsLayer({
            "brisbane._domainkey.football.example.com": [RFC_8463_ED25519_TXT],
          }),
        ),
      ),
    );
    expect(edOnly._tag).toBe("DkimVerified");
    if (edOnly._tag !== "DkimVerified") throw new Error("expected verified");
    expect({
      signingDomain: edOnly.signingDomain,
      selector: edOnly.selector,
      algorithm: edOnly.algorithm,
      fromHeader: edOnly.fromHeader,
      fromAddress: edOnly.fromAddress,
      fromDomain: edOnly.fromDomain,
      matchedAllowedDomain: edOnly.matchedAllowedDomain,
      signedSubject: edOnly.signedSubject,
      signedDate: edOnly.signedDate,
      signedMessageId: edOnly.signedMessageId,
    }).toEqual({
      signingDomain: "football.example.com",
      selector: "brisbane",
      algorithm: "ed25519-sha256",
      fromHeader: "Joe SixPack <joe@football.example.com>",
      fromAddress: "joe@football.example.com",
      fromDomain: "football.example.com",
      matchedAllowedDomain: "example.com",
      signedSubject: "Is dinner ready?",
      signedDate: "Fri, 11 Jul 2003 21:00:37 -0700 (PDT)",
      signedMessageId: "<20030712040037.46341.5F8J@football.example.com>",
    });

    // RFC 6376 §3.2 & §3.6.1: tag names are case-sensitive (`V=custom` after `v=DKIM1` is valid),
    // whereas placing `v=DKIM1` after another tag MUST be rejected.
    const rsaWithExtensionAfterV = await Effect.runPromise(
      verifyAlertDkim(RFC_8463_APPENDIX_A_MESSAGE, ["example.com"]).pipe(
        Effect.provide(
          mockDnsLayer({
            "test._domainkey.football.example.com": [
              RFC_8463_RSA_TXT.replace("v=DKIM1;", "v=DKIM1; V=custom;"),
            ],
          }),
        ),
      ),
    );
    expect(rsaWithExtensionAfterV._tag).toBe("DkimVerified");
    if (rsaWithExtensionAfterV._tag !== "DkimVerified") throw new Error("expected verified");
    expect(rsaWithExtensionAfterV.algorithm).toBe("rsa-sha256");
    expect(rsaWithExtensionAfterV.selector).toBe("test");

    const rsaWithVNotFirst = await Effect.runPromise(
      verifyAlertDkim(RFC_8463_APPENDIX_A_MESSAGE, ["example.com"]).pipe(
        Effect.provide(
          mockDnsLayer({
            "test._domainkey.football.example.com": [`V=custom; ${RFC_8463_RSA_TXT}`],
          }),
        ),
      ),
    );
    expect(rsaWithVNotFirst._tag).toBe("DkimRejected");

    // Case-sensitive `b=` stripping: uppercase extension `B=ignored` before lowercase `b=` MUST verify.
    const withUppercaseBExt = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s-ext",
      fromHeader: "alerts-noreply@google.com",
      subject: "Uppercase B extension",
      body: "Hello\r\n",
      extraDkimTags: "B=ignored-extension-value",
    });
    const uppercaseBRes = await Effect.runPromise(
      verifyAlertDkim(withUppercaseBExt.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(withUppercaseBExt.dnsRecords)),
      ),
    );
    expect(uppercaseBRes._tag).toBe("DkimVerified");

    // Exact duplicate tag names and invalid tag-name grammar must be rejected.
    expect(parseTagList("v=DKIM1; V=custom")).toBeDefined();
    expect(parseTagList("v=DKIM1; v=DKIM1")).toBeUndefined();
    expect(parseTagList("1bad=foo; v=DKIM1")).toBeUndefined();
    expect(parseTagList("a-b=foo; v=DKIM1")).toBeUndefined();
    expect(parseTagList("v=DKIM1; ext_1=ok;")).toBeDefined();
  });

  test("verifies valid RSA-SHA256 & Ed25519-SHA256 signatures and enforces RFC 6376 t=s against i=, s= service, RSA >= 1024b, and duplicate tags", async () => {
    const validStrictIdentity = buildDkimSignedMessage({
      algorithm: "ed25519-sha256",
      signingDomain: "mg.posthog.com",
      selector: "ed1",
      fromHeader: "PostHog Alerts <alerts@posthog.com>",
      subject: "Error spike detected",
      body: "5xx rate jumped above threshold.\r\n",
      canon: "simple/simple",
      extraDkimTags: "i=@mg.posthog.com",
      keyFlags: "s",
      keyService: "email",
    });
    const validStrictRes = await Effect.runPromise(
      verifyAlertDkim(validStrictIdentity.raw, ["google.com", "posthog.com"]).pipe(
        Effect.provide(mockDnsLayer(validStrictIdentity.dnsRecords)),
      ),
    );
    expect(validStrictRes._tag).toBe("DkimVerified");

    const badStrictIdentity = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "posthog.com",
      selector: "s1",
      fromHeader: "alerts@posthog.com",
      subject: "Bad strict identity",
      body: "Hello\r\n",
      extraDkimTags: "i=@sub.posthog.com",
      keyFlags: "s",
    });
    const badStrictRes = await Effect.runPromise(
      verifyAlertDkim(badStrictIdentity.raw, ["posthog.com"]).pipe(
        Effect.provide(mockDnsLayer(badStrictIdentity.dnsRecords)),
      ),
    );
    expect(badStrictRes._tag).toBe("DkimRejected");

    const wrongService = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Wrong service",
      body: "Hello\r\n",
      keyService: "other",
    });
    const wrongServiceRes = await Effect.runPromise(
      verifyAlertDkim(wrongService.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(wrongService.dnsRecords)),
      ),
    );
    expect(wrongServiceRes._tag).toBe("DkimRejected");

    const weakRsa = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Weak RSA",
      body: "Hello\r\n",
      rsaModulusLength: 512,
    });
    const weakRsaRes = await Effect.runPromise(
      verifyAlertDkim(weakRsa.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(weakRsa.dnsRecords)),
      ),
    );
    expect(weakRsaRes._tag).toBe("DkimRejected");

    const dupTag = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Duplicate tag",
      body: "Hello\r\n",
      extraDkimTags: "v=1",
    });
    const dupTagRes = await Effect.runPromise(
      verifyAlertDkim(dupTag.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(dupTag.dnsRecords)),
      ),
    );
    expect(dupTagRes._tag).toBe("DkimRejected");
  });

  test("rejects tampered bodies, untrusted domains, misaligned From, l= tag, duplicate From, expired x=, and marks transient DNS separately", async () => {
    const cases: Array<SignedEmailFixture> = [
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "alerts-noreply@google.com",
        subject: "Alert",
        body: "Legit\r\n",
        tamperBodyAfterSign: "Tampered\r\n",
      }),
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "evil-google.com",
        selector: "s1",
        fromHeader: "alerts@evil-google.com",
        subject: "Spoofed",
        body: "Hello\r\n",
      }),
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "attacker@attacker.invalid",
        subject: "Misaligned From",
        body: "Hello\r\n",
      }),
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "alerts-noreply@google.com",
        subject: "Shadowed From",
        body: "Hello\r\n",
        extraHeaders: ["From: attacker@attacker.invalid"],
      }),
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "alerts-noreply@google.com",
        subject: "Has l= tag",
        body: "Hello\r\n",
        extraDkimTags: "l=5",
      }),
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "alerts-noreply@google.com",
        subject: "Expired",
        body: "Hello\r\n",
        extraDkimTags: "t=1000; x=1001",
      }),
    ];

    for (const fixture of cases) {
      const res = await Effect.runPromise(
        verifyAlertDkim(fixture.raw, ["google.com"]).pipe(
          Effect.provide(mockDnsLayer(fixture.dnsRecords)),
        ),
      );
      expect(res._tag).toBe("DkimRejected");
    }

    const transientDns = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Transient DNS",
      body: "Hello\r\n",
    });
    const transientRes = await Effect.runPromise(
      verifyAlertDkim(transientDns.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer({ "s1._domainkey.google.com": "ETIMEOUT" })),
      ),
    );
    expect(transientRes._tag).toBe("DkimTransientError");
  });

  test("renders title and MIME body strictly from DKIM-verified headers, ignoring unsigned or prepended duplicate Subject/MIME headers", async () => {
    // 1. Only From is signed -> unsigned Subject uses neutral title; unsigned Content-Disposition: attachment cannot hide body.
    const unsignedSubjectAndMime = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "INJECTED UNSIGNED SUBJECT",
      contentDisposition: 'attachment; filename="hidden.bin"',
      body: "Visible verified body text\r\n",
      signedHeaderNames: ["from"],
    });
    const verifiedUnsigned = await Effect.runPromise(
      verifyAlertDkim(unsignedSubjectAndMime.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(unsignedSubjectAndMime.dnsRecords)),
      ),
    );
    expect(verifiedUnsigned._tag).toBe("DkimVerified");
    if (verifiedUnsigned._tag !== "DkimVerified") throw new Error("expected verified");
    expect(verifiedUnsigned.signedSubject).toBeUndefined();
    expect(verifiedUnsigned.signedContentDisposition).toBeUndefined();
    const neutralIssue = formatAlertIssue({
      verified: verifiedUnsigned,
      archiveUri: "gs://bucket/a.eml",
      dedupKey: "abc123",
    });
    expect(neutralIssue.title).toBe("Alert (google.com): Monitoring notification");
    expect(neutralIssue.title).not.toContain("INJECTED");
    expect(neutralIssue.body).toContain("Visible verified body text");

    // 2. Prepended unsigned Subject + Content-Type + Content-Disposition + Content-Transfer-Encoding
    // above signed HTML/base64 headers: verified bottom headers MUST win!
    const encodedHtml = Buffer.from("<p>Verified HTML incident body</p>", "utf8").toString(
      "base64",
    );
    const prependedMime = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s2",
      fromHeader: "alerts-noreply@google.com",
      subject: "Legit signed incident",
      contentType: 'text/html; charset="utf-8"',
      contentTransferEncoding: "base64",
      body: `${encodedHtml}\r\n`,
      signedHeaderNames: ["from", "subject", "content-type", "content-transfer-encoding"],
      prependHeaders: [
        "Subject: SPOOFED TOP SUBJECT",
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Disposition: attachment; filename="spoof.txt"',
        "Content-Transfer-Encoding: 7bit",
      ],
    });
    const verifiedPrepended = await Effect.runPromise(
      verifyAlertDkim(prependedMime.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(prependedMime.dnsRecords)),
      ),
    );
    expect(verifiedPrepended._tag).toBe("DkimVerified");
    if (verifiedPrepended._tag !== "DkimVerified") throw new Error("expected verified");
    const prependedIssue = formatAlertIssue({
      verified: verifiedPrepended,
      archiveUri: "gs://bucket/b.eml",
      dedupKey: "def456",
    });
    expect(prependedIssue.title).toBe("Alert (google.com): Legit signed incident");
    expect(prependedIssue.body).toContain("Verified HTML incident body");
    expect(prependedIssue.body).not.toContain(encodedHtml);
    expect(prependedIssue.labels).toEqual([ALERT_ISSUE_LABEL]);
  });
});

describe("Alert inbox operational invariants (migration, concurrency, recovery, fairness, SQLite)", () => {
  test("redacts secrets and safely fences triple backticks", () => {
    expect(
      redactAlertText("key=re_1234567890abcdef token=secret123 Bearer abcdefghijklmnop1234"),
    ).toBe("key=[REDACTED] token=[REDACTED] [REDACTED]");
    const issue = formatAlertIssue({
      verified: {
        _tag: "DkimVerified",
        signingDomain: "google.com",
        selector: "20230601",
        algorithm: "rsa-sha256",
        fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
        fromAddress: "alerts-noreply@google.com",
        fromDomain: "google.com",
        matchedAllowedDomain: "google.com",
        signedSubject: "[ALERT] 5xx spike",
        signedDate: "Fri, 27 Nov 2026 21:00:00 +0000",
        signedMessageId: "<inc-1@google.com>",
        signedContentType: 'text/plain; charset="utf-8"',
        signedContentDisposition: undefined,
        signedContentTransferEncoding: undefined,
        verifiedBodyBytes: Buffer.from(
          "```markdown\r\nAttempted breakout with re_abcdefghijklmnop\r\n```",
          "utf8",
        ),
      },
      archiveUri: "gs://kvitbit-prod-mail-archive-prod/inbound/alerts/by-hash/abc/1.eml",
      dedupKey: "deadbeef",
    });
    expect(issue.labels).toEqual(["alert"]);
    expect(issue.body).not.toContain("re_abcdefghijklmnop");
    expect(issue.body).toContain("[REDACTED]");
    expect(issue.body).toContain("~~~text\n```markdown");
    expect(issue.body).toContain("<!-- kvitbit-alert-key:deadbeef -->");
  });

  test("migrates populated Round 1 SQLite DB preserving issue numbers while clearing unverified historical Message-IDs, and rejects corrupt or wrong-schema readonly DBs", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kvitbit-alert-migrate-"));
    try {
      // 1. Corrupt file surfaces AlertStoreError
      const corruptPath = join(tmpDir, "corrupt.sqlite");
      writeFileSync(corruptPath, "not a sqlite database");
      const corruptErr = await Effect.runPromise(
        Effect.flip(Effect.scoped(openAlertInboxStore(corruptPath, true))),
      );
      expect(corruptErr._tag).toBe("AlertStoreError");

      // 2. Valid SQLite DB with only an unrelated table fails readonly open with AlertStoreError
      const unrelatedPath = join(tmpDir, "unrelated.sqlite");
      const unrelatedDb = new Database(unrelatedPath);
      unrelatedDb.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, name TEXT);");
      unrelatedDb.close();
      const wrongSchemaErr = await Effect.runPromise(
        Effect.flip(Effect.scoped(openAlertInboxStore(unrelatedPath, true))),
      );
      expect(wrongSchemaErr._tag).toBe("AlertStoreError");

      // 3. Populated legacy Round 1 schema migrates cleanly on writable open
      const legacyPath = join(tmpDir, "legacy-r1.sqlite");
      const legacyDb = new Database(legacyPath);
      legacyDb.exec(`
        CREATE TABLE processed_alert (
          object_key TEXT PRIMARY KEY,
          delivery_hash TEXT NOT NULL,
          message_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('created', 'duplicate', 'rejected')),
          issue_number INTEGER,
          reason TEXT,
          processed_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO processed_alert (
          object_key, delivery_hash, message_id, status, issue_number, reason, processed_at
        ) VALUES (
          'inbound/alerts/by-hash/${"a".repeat(32)}/1000-old.eml',
          '${"a".repeat(32)}',
          '<unsigned-legacy@google.com>',
          'created',
          42,
          NULL,
          '2026-11-27T18:00:00.000Z'
        );
      `);
      legacyDb.close();

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(legacyPath, false);
            const rows = yield* store.listAll();
            expect(rows).toHaveLength(1);
            expect(rows[0]?.issueNumber).toBe(42);
            expect(rows[0]?.deliveryHash).toBe("a".repeat(32));
            // Historical Round 1 message_id was unverified -> cleared on migration.
            expect(rows[0]?.messageId).toBeNull();
            expect(rows[0]?.dedupKey).toBeNull();

            // Delivery-hash lookup still preserves #42.
            const byHash = yield* store.findByDeliveryHash("a".repeat(32));
            expect(byHash?.issueNumber).toBe(42);

            // Historical unverified Message-ID does NOT falsely match.
            const byLegacyMsg = yield* store.findByDedupKeyOrMessageId(
              "different-dedup",
              "<unsigned-legacy@google.com>",
            );
            expect(byLegacyMsg).toBeNull();
          }),
        ),
      );

      // Migrated DB now opens cleanly in readonly mode too.
      const roRows = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const roStore = yield* openAlertInboxStore(legacyPath, true);
            return yield* roStore.listAll();
          }),
        ),
      );
      expect(roRows[0]?.issueNumber).toBe(42);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("prevents duplicate issue creation across overlapping concurrent passes on the same SQLite DB", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kvitbit-alert-concurrent-"));
    try {
      const dbPath = join(tmpDir, "state.sqlite");
      const alert = buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
        subject: "Concurrent alert",
        messageId: "<concurrent-1@google.com>",
        body: "Alert body\r\n",
      });
      const objKey = `inbound/alerts/by-hash/${"e".repeat(32)}/1000-race.eml`;
      const posted: Array<number> = [];

      const sharedLayer = Layer.mergeAll(
        Layer.succeed(AlertBucket, {
          listObjects: () => Effect.succeed([objKey]),
          downloadObject: () => Effect.succeed(alert.raw),
        }),
        Layer.succeed(AlertIssueTracker, {
          ensureLabel: () => Effect.void,
          findExistingIssueByMarker: () => Effect.succeed(null),
          createIssue: () =>
            Effect.promise(async () => {
              // Simulate slow GitHub API round-trip so the second pass overlaps.
              await Bun.sleep(40);
              const number = 800 + posted.length + 1;
              posted.push(number);
              return { number, url: `https://github.com/KvitBit/KvitBit/issues/${number}` };
            }),
        }),
        mockDnsLayer(alert.dnsRecords),
      );

      // Initialize schema once, then run two independent passes concurrently against the same DB file.
      await Effect.runPromise(Effect.scoped(openAlertInboxStore(dbPath, false)));

      const runOnePass = () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openAlertInboxStore(dbPath, false);
              return yield* runAlertInboxPass({
                apply: true,
                bucket: "kvitbit-prod-mail-archive-prod",
                prefix: "inbound/alerts/",
                repo: "KvitBit/KvitBit",
                allowedDomains: ["google.com"],
                maxPerPass: 5,
                store,
              });
            }),
          ).pipe(Effect.provide(sharedLayer)),
        );

      const [r1, r2] = await Promise.all([runOnePass(), runOnePass()]);
      expect(posted).toEqual([801]);
      expect(r1.created.length + r2.created.length).toBe(1);

      const persisted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, true);
            return yield* store.getObject(objKey);
          }),
        ),
      );
      expect(persisted?.status).toBe("created");
      expect(persisted?.issueNumber).toBe(801);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("prevents stale expired-lease holder from posting or overwriting AND prevents delayed download from downgrading a created row", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kvitbit-alert-overlap-"));
    try {
      const dbPath = join(tmpDir, "overlap.sqlite");
      const sharedMsgId = "<overlap-incident@google.com>";
      const alert1 = buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s1",
        fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
        subject: "Overlap incident",
        messageId: sharedMsgId,
        body: "First delivery\r\n",
      });
      const alert2 = buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector: "s2",
        fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
        subject: "Overlap incident",
        messageId: sharedMsgId,
        body: "Redelivered copy\r\n",
      });
      const objKey1 = `inbound/alerts/by-hash/${"f".repeat(32)}/1000-first.eml`;
      const objKey2 = `inbound/alerts/by-hash/${"9".repeat(32)}/2000-second.eml`;

      // 1. Expired-lease overlap schedule: Pass 1 pauses during ensureLabel; lease is backdated in
      // SQLite; Pass 2 runs concurrently; Pass 1 resumes -> ONLY ONE issue (#801) is posted and recorded.
      let releaseEnsureLabel!: () => void;
      const ensureLabelGate = new Promise<void>((resolve) => {
        releaseEnsureLabel = resolve;
      });
      let notifyInEnsureLabel!: () => void;
      const inEnsureLabel = new Promise<void>((resolve) => {
        notifyInEnsureLabel = resolve;
      });
      let ensureCalls = 0;
      const postedNumbers: Array<number> = [];

      const leaseLayer = Layer.mergeAll(
        Layer.succeed(AlertBucket, {
          listObjects: () => Effect.succeed([objKey1]),
          downloadObject: () => Effect.succeed(alert1.raw),
        }),
        Layer.succeed(AlertIssueTracker, {
          ensureLabel: () =>
            Effect.promise(async () => {
              ensureCalls += 1;
              if (ensureCalls === 1) {
                notifyInEnsureLabel();
                await ensureLabelGate;
              }
            }),
          findExistingIssueByMarker: () => Effect.succeed(null),
          createIssue: () =>
            Effect.sync(() => {
              const number = 800 + postedNumbers.length + 1;
              postedNumbers.push(number);
              return { number, url: `https://github.com/KvitBit/KvitBit/issues/${number}` };
            }),
        }),
        mockDnsLayer(alert1.dnsRecords),
      );

      await Effect.runPromise(Effect.scoped(openAlertInboxStore(dbPath, false)));

      const pass1Promise = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, false);
            return yield* runAlertInboxPass({
              apply: true,
              bucket: "kvitbit-prod-mail-archive-prod",
              prefix: "inbound/alerts/",
              repo: "KvitBit/KvitBit",
              allowedDomains: ["google.com"],
              maxPerPass: 5,
              store,
            });
          }),
        ).pipe(Effect.provide(leaseLayer)),
      );

      await inEnsureLabel;
      // Expire the SQLite lease directly while Pass 1 is paused in ensureLabel.
      const expireDb = new Database(dbPath);
      expireDb.exec(
        "UPDATE processed_alert SET claim_expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'claiming'",
      );
      expireDb.close();

      // Run Pass 2 concurrently while Pass 1 is still alive.
      const pass2Res = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, false);
            return yield* runAlertInboxPass({
              apply: true,
              bucket: "kvitbit-prod-mail-archive-prod",
              prefix: "inbound/alerts/",
              repo: "KvitBit/KvitBit",
              allowedDomains: ["google.com"],
              maxPerPass: 5,
              store,
            });
          }),
        ).pipe(Effect.provide(leaseLayer)),
      );
      releaseEnsureLabel();
      const pass1Res = await pass1Promise;

      expect(postedNumbers).toEqual([801]);
      expect(pass1Res.created.length + pass2Res.created.length).toBe(1);

      // 2. Direct fencing-token & immutable-created-row invariant (even without file lock):
      // Verify a stale claimGeneration cannot renew or overwrite, and markDuplicate/markRejected/
      // markRetry cannot downgrade `created` or wipe its dedup_key/message_id.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, false);
            const rowBefore = yield* store.getObject(objKey1);
            expect(rowBefore?.status).toBe("created");
            expect(rowBefore?.issueNumber).toBe(801);
            expect(rowBefore?.messageId).toBe(sharedMsgId);

            // Stale generation cannot renew or overwrite #801.
            const renewed = yield* store.verifyAndRenewClaim({
              objectKey: objKey1,
              claimGeneration: rowBefore?.claimGeneration ?? 1,
              nowIso: "2026-11-27T21:00:00.000Z",
              leaseUntilIso: "2026-11-27T21:05:00.000Z",
            });
            expect(renewed).toBe(false);
            const overwritten = yield* store.markCreated({
              objectKey: objKey1,
              claimGeneration: rowBefore?.claimGeneration ?? 1,
              issueNumber: 802,
              nowIso: "2026-11-27T21:00:00.000Z",
            });
            expect(overwritten).toBe(false);

            // Delayed pass attempting markDuplicate on the same objectKey MUST NOT downgrade `created`.
            yield* store.markDuplicate({
              objectKey: objKey1,
              deliveryHash: "f".repeat(32),
              dedupKey: null,
              messageId: null,
              issueNumber: 801,
              reason: "stale self-duplicate",
              nowIso: "2026-11-27T21:01:00.000Z",
            });
            const rowAfter = yield* store.getObject(objKey1);
            expect(rowAfter?.status).toBe("created");
            expect(rowAfter?.issueNumber).toBe(801);
            expect(rowAfter?.messageId).toBe(sharedMsgId);
            expect(rowAfter?.dedupKey).not.toBeNull();
          }),
        ),
      );

      // 3. Subsequent redelivery with same signed Message-ID deduplicates cleanly against #801!
      const redeliveryLayer = Layer.mergeAll(
        Layer.succeed(AlertBucket, {
          listObjects: () => Effect.succeed([objKey1, objKey2]),
          downloadObject: (_b, key) => Effect.succeed(key === objKey1 ? alert1.raw : alert2.raw),
        }),
        Layer.succeed(AlertIssueTracker, {
          ensureLabel: () => Effect.void,
          findExistingIssueByMarker: () => Effect.succeed(null),
          createIssue: () => {
            postedNumbers.push(802);
            return Effect.succeed({
              number: 802,
              url: "https://github.com/KvitBit/KvitBit/issues/802",
            });
          },
        }),
        mockDnsLayer({ ...alert1.dnsRecords, ...alert2.dnsRecords }),
      );

      const redeliveryRes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, false);
            return yield* runAlertInboxPass({
              apply: true,
              bucket: "kvitbit-prod-mail-archive-prod",
              prefix: "inbound/alerts/",
              repo: "KvitBit/KvitBit",
              allowedDomains: ["google.com"],
              maxPerPass: 5,
              store,
            });
          }),
        ).pipe(Effect.provide(redeliveryLayer)),
      );
      expect(postedNumbers).toEqual([801]);
      expect(redeliveryRes.created).toHaveLength(0);
      expect(redeliveryRes.duplicates).toEqual([
        { objectKey: objKey2, matchedBy: "dedup_key", existingIssueNumber: 801 },
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("enforces OS kernel flock across SIGKILL crash recovery, competing processes, database symlinks, and superseded claiming generations", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kvitbit-alert-flock-"));
    try {
      const dbPath = join(tmpDir, "state.sqlite");
      const symPath = join(tmpDir, "alias.sqlite");
      const storeModulePath = join(import.meta.dir, "store.ts");

      // Initialize database and create a symlink alias to the same backing file.
      await Effect.runPromise(Effect.scoped(openAlertInboxStore(dbPath, false)));
      symlinkSync(dbPath, symPath);

      // 1. Cross-process SIGKILL crash recovery + competing process race:
      // Holder acquires kernel flock, prints READY, then is SIGKILL'd without cleanup.
      // Two competing processes then race simultaneously to acquire the lock and hold it 150ms:
      // strictly ONE wins (`acquired: true`), the other gets `acquired: false`, and after the
      // winner exits a fresh caller succeeds cleanly.
      const holderScript = `
        import { Effect } from "effect";
        import { openAlertInboxStore } from ${JSON.stringify(storeModulePath)};
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openAlertInboxStore(${JSON.stringify(dbPath)}, false);
              yield* store.withExclusiveApplyLock(
                Effect.promise(async () => {
                  process.stdout.write("READY\\n");
                  await Bun.sleep(10_000);
                }),
              );
            }),
          ),
        );
      `;
      const holder = Bun.spawn(["bun", "-e", holderScript], { stdout: "pipe", stderr: "pipe" });
      const reader = holder.stdout.getReader();
      const firstChunk = await reader.read();
      reader.releaseLock();
      expect(Buffer.from(firstChunk.value ?? new Uint8Array()).toString("utf8")).toContain("READY");

      // While holder is alive, opening via the SYMLINK alias MUST fail to acquire the lock!
      const busyViaSymlink = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const symStore = yield* openAlertInboxStore(symPath, false);
            return yield* symStore.withExclusiveApplyLock(Effect.succeed("should-not-run"));
          }),
        ),
      );
      expect(busyViaSymlink).toEqual({ acquired: false });

      // SIGKILL the holder (no graceful teardown, kernel releases flock atomically).
      holder.kill(9);
      await holder.exited;

      // Spawn two competing child processes (one via direct path, one via symlink!) racing to acquire.
      const racerScript = (targetPath: string) => `
        import { Effect } from "effect";
        import { openAlertInboxStore } from ${JSON.stringify(storeModulePath)};
        const res = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openAlertInboxStore(${JSON.stringify(targetPath)}, false);
              return yield* store.withExclusiveApplyLock(
                Effect.promise(async () => {
                  await Bun.sleep(200);
                  return "won";
                }),
              );
            }),
          ),
        );
        process.stdout.write(JSON.stringify(res));
      `;
      const racer1 = Bun.spawn(["bun", "-e", racerScript(dbPath)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const racer2 = Bun.spawn(["bun", "-e", racerScript(symPath)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out1, out2, code1, code2] = await Promise.all([
        new Response(racer1.stdout).text(),
        new Response(racer2.stdout).text(),
        racer1.exited,
        racer2.exited,
      ]);
      expect(code1).toBe(0);
      expect(code2).toBe(0);
      const parsed1 = JSON.parse(out1) as { acquired: boolean };
      const parsed2 = JSON.parse(out2) as { acquired: boolean };
      expect([parsed1.acquired, parsed2.acquired].filter(Boolean)).toHaveLength(1);

      // 2. Superseded generation fencing while the row is STILL `claiming` (not yet `created`):
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openAlertInboxStore(dbPath, false);
            const objKey = `inbound/alerts/by-hash/${"7".repeat(32)}/1000-gen.eml`;
            const dedupKey = "7".repeat(32);

            const c1 = yield* store.tryClaimForCreation({
              objectKey: objKey,
              deliveryHash: dedupKey,
              dedupKey,
              messageId: "<gen-test@google.com>",
              nowIso: "2026-11-27T21:00:00.000Z",
              leaseUntilIso: "2026-11-27T21:05:00.000Z",
            });
            expect(c1.outcome).toBe("acquired");
            if (c1.outcome !== "acquired") throw new Error("expected acquired");
            const gen1 = c1.claimGeneration;

            // Lease expires and second holder takes over -> row stays `claiming` at gen2 > gen1.
            const c2 = yield* store.tryClaimForCreation({
              objectKey: objKey,
              deliveryHash: dedupKey,
              dedupKey,
              messageId: "<gen-test@google.com>",
              nowIso: "2026-11-27T21:10:00.000Z",
              leaseUntilIso: "2026-11-27T21:15:00.000Z",
            });
            expect(c2.outcome).toBe("acquired");
            if (c2.outcome !== "acquired") throw new Error("expected acquired");
            const gen2 = c2.claimGeneration;
            expect(gen2).toBeGreaterThan(gen1);

            // Stale gen1 MUST be rejected by verifyAndRenewClaim, markCreated, and markRetry
            // while row is STILL in `claiming` state!
            const staleRenew = yield* store.verifyAndRenewClaim({
              objectKey: objKey,
              claimGeneration: gen1,
              nowIso: "2026-11-27T21:11:00.000Z",
              leaseUntilIso: "2026-11-27T21:16:00.000Z",
            });
            expect(staleRenew).toBe(false);

            const staleCreate = yield* store.markCreated({
              objectKey: objKey,
              claimGeneration: gen1,
              issueNumber: 999,
              nowIso: "2026-11-27T21:11:00.000Z",
            });
            expect(staleCreate).toBe(false);

            yield* store.markRetry({
              objectKey: objKey,
              deliveryHash: dedupKey,
              dedupKey,
              messageId: "<gen-test@google.com>",
              keepClaiming: true,
              expectedClaimGeneration: gen1,
              reason: "stale failure",
              nextRetryAt: "2026-11-27T21:20:00.000Z",
              nowIso: "2026-11-27T21:11:00.000Z",
            });

            // Gen2's active `claiming` lease is completely untouched!
            const stillGen2 = yield* store.getObject(objKey);
            expect(stillGen2?.status).toBe("claiming");
            expect(stillGen2?.claimGeneration).toBe(gen2);
            expect(stillGen2?.claimExpiresAt).toBe("2026-11-27T21:15:00.000Z");
            expect(stillGen2?.issueNumber).toBeNull();

            // Gen2 succeeds cleanly.
            const validCreate = yield* store.markCreated({
              objectKey: objKey,
              claimGeneration: gen2,
              issueNumber: 888,
              nowIso: "2026-11-27T21:12:00.000Z",
            });
            expect(validCreate).toBe(true);
            const finalRow = yield* store.getObject(objKey);
            expect(finalRow?.status).toBe("created");
            expect(finalRow?.issueNumber).toBe(888);
          }),
        ),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reconciles lost GitHub replies even after relabeling AND after DKIM key retirement, and queries GitHub without label filters", async () => {
    // 1. Verify makeGhAlertIssueTracker queries repos/<repo>/issues?state=all&per_page=100 WITHOUT labels=
    const seenUrls: Array<string> = [];
    const marker = alertIssueMarker("cafebabe");
    const ghTracker = makeGhAlertIssueTracker((cmd) => {
      seenUrls.push(cmd.join(" "));
      return Effect.succeed(
        Buffer.from(
          JSON.stringify([
            [
              {
                number: 901,
                html_url: "https://github.com/KvitBit/KvitBit/issues/901",
                labels: [{ name: "triaged" }], // `alert` label was replaced!
                body: `Relabeled issue\n<!-- ${marker} -->`,
              },
            ],
          ]),
          "utf8",
        ),
      );
    });
    const relabeledMatch = await Effect.runPromise(
      ghTracker.findExistingIssueByMarker("KvitBit/KvitBit", marker),
    );
    expect(relabeledMatch?.number).toBe(901);
    expect(seenUrls[0]).toContain("repos/KvitBit/KvitBit/issues?state=all&per_page=100");
    expect(seenUrls[0]).not.toContain("labels=");

    // 2. Commit issue #902 with lost reply, then RETIRE the sender's DNS key (ENOTFOUND),
    // and replace the `alert` label -> retry MUST reconcile #902 instead of marking rejected!
    const alert = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "retired-key",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "Key rotation test",
      messageId: "<key-rot-1@google.com>",
      body: "Incident before key rotation\r\n",
    });
    const key1 = `inbound/alerts/by-hash/${"d".repeat(32)}/1000-rot.eml`;
    const committedIssues: Array<{ number: number; body: string; labels: Array<string> }> = [];
    let dnsActive = true;
    let dropReply = true;

    const layer = Layer.mergeAll(
      Layer.succeed(AlertBucket, {
        listObjects: () => Effect.succeed([key1]),
        downloadObject: () => Effect.succeed(alert.raw),
      }),
      Layer.succeed(AlertIssueTracker, {
        ensureLabel: () => Effect.void,
        findExistingIssueByMarker: (_repo, m) =>
          Effect.sync(() => {
            // Search across all issues regardless of labels (matches live ghTracker behavior).
            const hit = committedIssues.find((i) => i.body.includes(m));
            return hit
              ? {
                  number: hit.number,
                  url: `https://github.com/KvitBit/KvitBit/issues/${hit.number}`,
                }
              : null;
          }),
        createIssue: (_repo, issue) =>
          Effect.gen(function* () {
            const number = 902 + committedIssues.length;
            committedIssues.push({ number, body: issue.body, labels: [...issue.labels] });
            if (dropReply) {
              dropReply = false;
              return yield* new AlertInboxError({ reason: "connection reset after commit" });
            }
            return { number, url: `https://github.com/KvitBit/KvitBit/issues/${number}` };
          }),
      }),
      Layer.succeed(DnsTxtResolver, {
        resolveTxt: (hostname) => {
          if (!dnsActive) {
            return Effect.fail(new DnsLookupError({ hostname, reason: "ENOTFOUND" }));
          }
          const rec = alert.dnsRecords[hostname];
          return rec
            ? Effect.succeed(rec)
            : Effect.fail(new DnsLookupError({ hostname, reason: "ENOTFOUND" }));
        },
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openAlertInboxStore(":memory:", false);

          // Pass 1: commits #902 on GitHub, then drops reply -> row stays `claiming` with dedupKey.
          const pass1 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 5,
            store,
          });
          expect(pass1.failures).toHaveLength(1);
          expect(committedIssues).toHaveLength(1);

          // Replace the issue's `alert` label with `triaged` AND retire the DKIM DNS key!
          if (committedIssues[0]) {
            committedIssues[0].labels = ["triaged"];
          }
          dnsActive = false;

          // Make the retry due immediately.
          const row = yield* store.getObject(key1);
          expect(row?.status).toBe("claiming");
          expect(row?.dedupKey).not.toBeNull();
          yield* store.markRetry({
            objectKey: key1,
            deliveryHash: row?.deliveryHash ?? "d".repeat(32),
            dedupKey: row?.dedupKey ?? null,
            messageId: row?.messageId ?? null,
            keepClaiming: true,
            reason: "retry ready",
            nextRetryAt: "2000-01-01T00:00:00.000Z",
            nowIso: "2026-11-27T21:00:00.000Z",
          });

          // Pass 2: reconciles #902 BEFORE re-verifying DKIM -> marked created (#902), NOT rejected!
          const pass2 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 5,
            store,
          });
          expect(pass2.rejected).toHaveLength(0);
          expect(pass2.created).toHaveLength(1);
          expect(pass2.created[0]?.issueNumber).toBe(902);
          expect(pass2.created[0]?.reconciled).toBe(true);
          expect(committedIssues).toHaveLength(1);

          const finalRow = yield* store.getObject(key1);
          expect(finalRow?.status).toBe("created");
          expect(finalRow?.issueNumber).toBe(902);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  test("schedules fresh arrivals and overdue retries fairly without starving either queue even at maxPerPass=1", async () => {
    const mkAlert = (selector: string, idx: number) =>
      buildDkimSignedMessage({
        algorithm: "rsa-sha256",
        signingDomain: "google.com",
        selector,
        fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
        subject: `Fairness alert ${idx}`,
        messageId: `<fair-${idx}@google.com>`,
        body: `Body ${idx}\r\n`,
      });

    const retryAlert = mkAlert("s0", 0);
    const fresh1 = mkAlert("s1", 1);
    const fresh2 = mkAlert("s2", 2);
    const retryKey = `inbound/alerts/by-hash/${"0".repeat(32)}/0001-retry.eml`;
    const freshKey1 = `inbound/alerts/by-hash/${"1".repeat(32)}/0002-fresh1.eml`;
    const freshKey2 = `inbound/alerts/by-hash/${"2".repeat(32)}/0003-fresh2.eml`;

    let availableKeys: Array<string> = [retryKey];
    let failRetryDownload = true;
    const rawMap: Record<string, Uint8Array> = {
      [retryKey]: retryAlert.raw,
      [freshKey1]: fresh1.raw,
      [freshKey2]: fresh2.raw,
    };
    const createdKeys: Array<string> = [];

    const layer = Layer.mergeAll(
      Layer.succeed(AlertBucket, {
        listObjects: () => Effect.succeed([...availableKeys]),
        downloadObject: (_bucket, key) => {
          if (key === retryKey && failRetryDownload) {
            return Effect.fail(new AlertInboxError({ reason: "transient read error" }));
          }
          const raw = rawMap[key];
          return raw
            ? Effect.succeed(raw)
            : Effect.fail(new AlertInboxError({ reason: "not found" }));
        },
      }),
      Layer.succeed(AlertIssueTracker, {
        ensureLabel: () => Effect.void,
        findExistingIssueByMarker: () => Effect.succeed(null),
        createIssue: (_repo, issue) =>
          Effect.sync(() => {
            createdKeys.push(issue.title);
            return {
              number: 600 + createdKeys.length,
              url: "https://github.com/KvitBit/KvitBit/issues/601",
            };
          }),
      }),
      mockDnsLayer({
        ...retryAlert.dnsRecords,
        ...fresh1.dnsRecords,
        ...fresh2.dnsRecords,
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openAlertInboxStore(":memory:", false);

          // Pass 1: retryKey fails download and enters retry queue.
          const p1 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(p1.failures.map((f) => f.objectKey)).toEqual([retryKey]);

          // Now retryKey becomes overdue AND freshKey1 arrives.
          failRetryDownload = false;
          yield* store.markRetry({
            objectKey: retryKey,
            deliveryHash: "0".repeat(32),
            dedupKey: null,
            messageId: null,
            keepClaiming: false,
            reason: "overdue",
            nextRetryAt: "2000-01-01T00:00:00.000Z",
            nowIso: "2026-11-27T21:00:00.000Z",
          });
          availableKeys = [retryKey, freshKey1];

          // Pass 2 (maxPerPass=1): lastScheduledQueue was "fresh" -> picks due retryKey (NO starvation!).
          const p2 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(p2.created.map((c) => c.objectKey)).toEqual([retryKey]);

          // Pass 3 (maxPerPass=1): freshKey2 also arrives -> freshKey1 progresses immediately.
          availableKeys = [retryKey, freshKey1, freshKey2];
          const p3 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(p3.created.map((c) => c.objectKey)).toEqual([freshKey1]);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  test("propagates missing gcloud or unavailable bucket errors while returning empty only for confirmed empty prefix", async () => {
    const missingGcloud = makeGcloudAlertBucket(() =>
      Effect.fail(new AlertInboxError({ reason: "Executable not found in $PATH: gcloud" })),
    );
    const missingGcloudErr = await Effect.runPromise(
      Effect.flip(missingGcloud.listObjects("kvitbit-prod-mail-archive-prod", "inbound/alerts/")),
    );
    expect(missingGcloudErr._tag).toBe("AlertInboxError");

    const missingBucket = makeGcloudAlertBucket((cmd) => {
      if (cmd[2] === "ls") {
        return Effect.fail(
          new AlertInboxError({ reason: "ERROR: One or more URLs matched no objects." }),
        );
      }
      return Effect.fail(new AlertInboxError({ reason: "ERROR: Bucket not found (404)" }));
    });
    const missingBucketErr = await Effect.runPromise(
      Effect.flip(missingBucket.listObjects("missing-bucket", "inbound/alerts/")),
    );
    expect(missingBucketErr._tag).toBe("AlertInboxError");

    const confirmedEmpty = makeGcloudAlertBucket((cmd) => {
      if (cmd[2] === "ls") {
        return Effect.fail(
          new AlertInboxError({ reason: "ERROR: One or more URLs matched no objects." }),
        );
      }
      return Effect.succeed(Buffer.from("kvitbit-prod-mail-archive-prod\n", "utf8"));
    });
    const emptyList = await Effect.runPromise(
      confirmedEmpty.listObjects("kvitbit-prod-mail-archive-prod", "inbound/alerts/"),
    );
    expect(emptyList).toEqual([]);
  });

  test("dry-run mutates neither GitHub nor SQLite, unverified Message-ID does not poison dedup, and CLI rejects --label override", async () => {
    const sharedMessageId = "<shared-incident-99@google.com>";
    const spoofedSameMsgId = Buffer.from(
      [
        "From: Cloud Monitoring <alerts-noreply@google.com>",
        "To: alerts@kvitbit.com",
        "Subject: Spoofed",
        `Message-ID: ${sharedMessageId}`,
        "",
        "Unsigned spoof trying to poison dedup.",
      ].join("\r\n"),
      "utf8",
    );
    const legitFirst = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "Real incident 99",
      messageId: sharedMessageId,
      body: "Authentic alert body.\r\n",
    });
    const legitRedelivery = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s2",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "Real incident 99",
      messageId: sharedMessageId,
      body: "Authentic alert body (redelivered).\r\n",
    });

    const spoofKey = `inbound/alerts/by-hash/${"a".repeat(32)}/1000-spoof.eml`;
    const legitKey1 = `inbound/alerts/by-hash/${"b".repeat(32)}/2000-legit1.eml`;
    const legitKey2 = `inbound/alerts/by-hash/${"c".repeat(32)}/3000-legit2.eml`;
    const createdIssues: Array<{ title: string; labels: ReadonlyArray<string> }> = [];

    const testLayer = Layer.mergeAll(
      Layer.succeed(AlertBucket, {
        listObjects: () => Effect.succeed([spoofKey, legitKey1, legitKey2]),
        downloadObject: (_bucket, key) => {
          if (key === spoofKey) return Effect.succeed(spoofedSameMsgId);
          if (key === legitKey1) return Effect.succeed(legitFirst.raw);
          if (key === legitKey2) return Effect.succeed(legitRedelivery.raw);
          return Effect.fail(new AlertInboxError({ reason: "not found" }));
        },
      }),
      Layer.succeed(AlertIssueTracker, {
        ensureLabel: () => Effect.void,
        findExistingIssueByMarker: () => Effect.succeed(null),
        createIssue: (_repo, issue) =>
          Effect.sync(() => {
            createdIssues.push({ title: issue.title, labels: issue.labels });
            return {
              number: 700 + createdIssues.length,
              url: "https://github.com/KvitBit/KvitBit/issues/701",
            };
          }),
      }),
      mockDnsLayer({ ...legitFirst.dnsRecords, ...legitRedelivery.dnsRecords }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openAlertInboxStore(":memory:", false);

          const dry = yield* runAlertInboxPass({
            apply: false,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 20,
            store,
          });
          expect(dry.rejected).toHaveLength(1);
          expect(dry.created).toHaveLength(2);
          expect(createdIssues).toHaveLength(0);
          expect(yield* store.listAll()).toHaveLength(0);

          const applied = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 20,
            store,
          });
          expect(applied.rejected.map((r) => r.objectKey)).toEqual([spoofKey]);
          expect(applied.created.map((c) => c.objectKey)).toEqual([legitKey1]);
          expect(applied.duplicates).toEqual([
            { objectKey: legitKey2, matchedBy: "dedup_key", existingIssueNumber: 701 },
          ]);
          expect(createdIssues).toEqual([
            { title: "Alert (google.com): Real incident 99", labels: [ALERT_ISSUE_LABEL] },
          ]);
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    const proc = Bun.spawn(
      ["bun", "scripts/alert-inbox/service.ts", "--label", "visual-feedback"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderrText, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderrText).toMatch(/Unknown option '--label'/);
  });
});
