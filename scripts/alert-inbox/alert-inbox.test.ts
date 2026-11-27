import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { parseEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import {
  canonicalizeBody,
  canonicalizeHeaderField,
  DnsLookupError,
  DnsTxtResolver,
  verifyAlertDkim,
} from "./dkim";
import { ALERT_ISSUE_LABEL, formatAlertIssue, redactAlertText } from "./issue";
import {
  AlertBucket,
  AlertInboxError,
  AlertIssueTracker,
  makeGcloudAlertBucket,
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
    'Content-Type: text/plain; charset="utf-8"',
    ...(params.extraHeaders ?? []),
  ];

  const signedNames = params.signedHeaderNames ?? [
    "from",
    "to",
    ...(params.subject !== undefined ? ["subject"] : []),
    "date",
    ...(params.messageId ? ["message-id"] : []),
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
  test("interoperates independently with BOTH RSA-SHA256 and Ed25519-SHA256 on published RFC 8463 Appendix A vector", async () => {
    const edOnly = await Effect.runPromise(
      verifyAlertDkim(RFC_8463_APPENDIX_A_MESSAGE, ["example.com"]).pipe(
        Effect.provide(
          mockDnsLayer({
            "brisbane._domainkey.football.example.com": [RFC_8463_ED25519_TXT],
          }),
        ),
      ),
    );
    expect(edOnly).toEqual({
      _tag: "DkimVerified",
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

    const rsaOnly = await Effect.runPromise(
      verifyAlertDkim(RFC_8463_APPENDIX_A_MESSAGE, ["example.com"]).pipe(
        Effect.provide(
          mockDnsLayer({
            "test._domainkey.football.example.com": [RFC_8463_RSA_TXT],
          }),
        ),
      ),
    );
    expect(rsaOnly).toEqual({
      _tag: "DkimVerified",
      signingDomain: "football.example.com",
      selector: "test",
      algorithm: "rsa-sha256",
      fromHeader: "Joe SixPack <joe@football.example.com>",
      fromAddress: "joe@football.example.com",
      fromDomain: "football.example.com",
      matchedAllowedDomain: "example.com",
      signedSubject: "Is dinner ready?",
      signedDate: "Fri, 11 Jul 2003 21:00:37 -0700 (PDT)",
      signedMessageId: "<20030712040037.46341.5F8J@football.example.com>",
    });
  });

  test("verifies valid RSA-SHA256 & Ed25519-SHA256 signatures and enforces RFC 6376 t=s against i=, s= service, RSA >= 1024b, and duplicate tags", async () => {
    // Valid subdomain signing with t=s when i=@mg.posthog.com (matches d=mg.posthog.com!)
    // while From: alerts@posthog.com aligns with allowed root domain posthog.com.
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

    // t=s MUST reject when i= is a subdomain of d= (i=@sub.posthog.com vs d=posthog.com)
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

    // Non-email DNS key service (`s=other`) must be rejected per RFC 6376 §3.6.1.
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

    // Weak 512-bit RSA key must be rejected per RFC 8301 §3.2.
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

    // Duplicate tag in DKIM-Signature must be rejected per RFC 6376 §3.2.
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

  test("uses only DKIM-verified header instances: neutral title when Subject is unsigned and ignores prepended unsigned duplicate Subject", async () => {
    // 1. Only From is signed -> Subject is unsigned -> neutral title must be used.
    const unsignedSubject = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "INJECTED UNSIGNED SUBJECT",
      body: "Body\r\n",
      signedHeaderNames: ["from"],
    });
    const verifiedUnsigned = await Effect.runPromise(
      verifyAlertDkim(unsignedSubject.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(unsignedSubject.dnsRecords)),
      ),
    );
    expect(verifiedUnsigned._tag).toBe("DkimVerified");
    if (verifiedUnsigned._tag !== "DkimVerified") throw new Error("expected verified");
    expect(verifiedUnsigned.signedSubject).toBeUndefined();
    const neutralIssue = formatAlertIssue({
      parsed: parseEmail(unsignedSubject.raw),
      verified: verifiedUnsigned,
      archiveUri: "gs://bucket/a.eml",
      dedupKey: "abc123",
    });
    expect(neutralIssue.title).toBe("Alert (google.com): Monitoring notification");
    expect(neutralIssue.title).not.toContain("INJECTED");

    // 2. Prepended unsigned duplicate Subject above a signed Subject -> verified Subject wins!
    const prependedSubject = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Legit signed incident",
      body: "Body\r\n",
      signedHeaderNames: ["from", "subject"],
      prependHeaders: ["Subject: SPOOFED TOP SUBJECT"],
    });
    const verifiedPrepended = await Effect.runPromise(
      verifyAlertDkim(prependedSubject.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(prependedSubject.dnsRecords)),
      ),
    );
    expect(verifiedPrepended._tag).toBe("DkimVerified");
    if (verifiedPrepended._tag !== "DkimVerified") throw new Error("expected verified");
    expect(verifiedPrepended.signedSubject).toBe("Legit signed incident");
    const prependedIssue = formatAlertIssue({
      parsed: parseEmail(prependedSubject.raw),
      verified: verifiedPrepended,
      archiveUri: "gs://bucket/b.eml",
      dedupKey: "def456",
    });
    expect(prependedIssue.title).toBe("Alert (google.com): Legit signed incident");
    expect(prependedIssue.labels).toEqual([ALERT_ISSUE_LABEL]);
  });
});

describe("Alert inbox operational invariants (GCS errors, lost replies, starvation, SQLite errors)", () => {
  test("redacts secrets and safely fences triple backticks", () => {
    expect(
      redactAlertText("key=re_1234567890abcdef token=secret123 Bearer abcdefghijklmnop1234"),
    ).toBe("key=[REDACTED] token=[REDACTED] [REDACTED]");
    const raw = Buffer.from(
      [
        "From: Cloud Monitoring <alerts-noreply@google.com>",
        "To: alerts@kvitbit.com",
        "Subject: [ALERT] 5xx spike",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "```markdown\r\nAttempted breakout with re_abcdefghijklmnop\r\n```",
      ].join("\r\n"),
      "utf8",
    );
    const issue = formatAlertIssue({
      parsed: parseEmail(raw),
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

  test("reconciles lost GitHub replies without creating duplicate issues, advances past failing objects, and handles invalid SQLite in Effect error channel", async () => {
    const alert1 = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "Alert One",
      messageId: "<inc-1@google.com>",
      body: "First incident\r\n",
    });
    const alert2 = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s2",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "Alert Two",
      messageId: "<inc-2@google.com>",
      body: "Second incident\r\n",
    });

    // 1. Corrupted SQLite file surfaces as typed AlertStoreError in Effect error channel.
    const tmpDir = mkdtempSync(join(tmpdir(), "kvitbit-alert-store-"));
    try {
      const corruptPath = join(tmpDir, "corrupt.sqlite");
      writeFileSync(corruptPath, "not a sqlite database");
      const openErr = await Effect.runPromise(
        Effect.flip(Effect.scoped(openAlertInboxStore(corruptPath, true))),
      );
      expect(openErr._tag).toBe("AlertStoreError");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2. Lost GitHub reply: createIssue commits on GitHub but returns error; next pass reconciles via marker.
    const committedIssues: Array<{ number: number; body: string; title: string }> = [];
    let dropFirstReply = true;
    const key1 = `inbound/alerts/by-hash/${"1".repeat(32)}/1000-aaaaaa.eml`;
    const key2 = `inbound/alerts/by-hash/${"2".repeat(32)}/2000-bbbbbb.eml`;
    const badKey = `inbound/alerts/by-hash/${"0".repeat(32)}/0500-000000.eml`;

    const lostReplyLayer = Layer.mergeAll(
      Layer.succeed(AlertBucket, {
        listObjects: () => Effect.succeed([badKey, key1, key2]),
        downloadObject: (_bucket, key) => {
          if (key === badKey) {
            return Effect.fail(new AlertInboxError({ reason: "transient GCS read error" }));
          }
          if (key === key1) return Effect.succeed(alert1.raw);
          if (key === key2) return Effect.succeed(alert2.raw);
          return Effect.fail(new AlertInboxError({ reason: "not found" }));
        },
      }),
      Layer.succeed(AlertIssueTracker, {
        ensureLabel: () => Effect.void,
        findExistingIssueByMarker: (_repo, marker) =>
          Effect.sync(() => {
            const hit = committedIssues.find((i) => i.body.includes(marker));
            return hit
              ? {
                  number: hit.number,
                  url: `https://github.com/KvitBit/KvitBit/issues/${hit.number}`,
                }
              : null;
          }),
        createIssue: (_repo, issue) =>
          Effect.gen(function* () {
            const number = 500 + committedIssues.length + 1;
            committedIssues.push({ number, body: issue.body, title: issue.title });
            if (dropFirstReply) {
              dropFirstReply = false;
              return yield* new AlertInboxError({ reason: "connection reset after commit" });
            }
            return { number, url: `https://github.com/KvitBit/KvitBit/issues/${number}` };
          }),
      }),
      mockDnsLayer({ ...alert1.dnsRecords, ...alert2.dnsRecords }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openAlertInboxStore(":memory:", false);

          // Pass 1 (maxPerPass=1): badKey fails download and enters retry backoff.
          const pass1 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(pass1.failures).toHaveLength(1);
          expect(pass1.failures[0]?.objectKey).toBe(badKey);

          // Pass 2 (maxPerPass=1): badKey is backed off, so key1 gets its turn (no starvation!).
          // key1 commits on GitHub (#501) then drops the reply -> recorded in `claiming` state.
          const pass2 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(pass2.failures).toHaveLength(1);
          expect(pass2.failures[0]?.objectKey).toBe(key1);
          expect(committedIssues).toHaveLength(1);

          // Pass 3 (maxPerPass=1): fresh key2 runs ahead of backed-off retries and succeeds (#502).
          const pass3 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(pass3.created).toHaveLength(1);
          expect(pass3.created[0]?.objectKey).toBe(key2);
          expect(pass3.created[0]?.issueNumber).toBe(502);
          expect(committedIssues).toHaveLength(2);

          // Simulate retry window elapsing for key1 by resetting its nextRetryAt to past,
          // then verify key1 reconciles existing #501 via marker WITHOUT creating a duplicate!
          yield* store.markRetry({
            objectKey: key1,
            deliveryHash: "1".repeat(32),
            dedupKey: null,
            messageId: null,
            keepClaiming: true,
            reason: "retry ready",
            nextRetryAt: "2000-01-01T00:00:00.000Z",
            nowIso: "2026-11-27T21:00:00.000Z",
          });
          const pass4 = yield* runAlertInboxPass({
            apply: true,
            bucket: "kvitbit-prod-mail-archive-prod",
            prefix: "inbound/alerts/",
            repo: "KvitBit/KvitBit",
            allowedDomains: ["google.com"],
            maxPerPass: 1,
            store,
          });
          expect(pass4.created).toHaveLength(1);
          expect(pass4.created[0]?.objectKey).toBe(key1);
          expect(pass4.created[0]?.issueNumber).toBe(501);
          expect(pass4.created[0]?.reconciled).toBe(true);
          // Total committed issues stayed at 2 (zero duplicate created for key1!).
          expect(committedIssues).toHaveLength(2);
        }),
      ).pipe(Effect.provide(lostReplyLayer)),
    );
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

          // 1. Dry-run creates 0 issues and writes 0 rows to SQLite.
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

          // 2. Apply pass: spoofed Message-ID is rejected without poisoning dedup;
          // legitKey1 creates #701 with label `alert`; legitKey2 deduplicates against signed Message-ID.
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

    // 3. CLI rejects any --label override (cannot pass visual-feedback).
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
