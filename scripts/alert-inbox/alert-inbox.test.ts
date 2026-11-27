import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { Effect, Layer } from "effect";
import { parseEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import {
  canonicalizeBody,
  canonicalizeHeaderField,
  DnsLookupError,
  DnsTxtResolver,
  verifyAlertDkim,
} from "./dkim";
import { formatAlertIssue, redactAlertText } from "./issue";
import { AlertBucket, AlertInboxError, AlertIssueTracker, runAlertInboxPass } from "./service";
import { AlertInboxStore } from "./store";

interface SignedEmailFixture {
  readonly raw: Uint8Array;
  readonly dnsRecords: Record<string, ReadonlyArray<string>>;
}

const buildDkimSignedMessage = (params: {
  readonly algorithm: "rsa-sha256" | "ed25519-sha256";
  readonly signingDomain: string;
  readonly selector: string;
  readonly fromHeader: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly body: string;
  readonly canon?: "relaxed/relaxed" | "simple/simple";
  readonly extraHeaders?: ReadonlyArray<string>;
  readonly signedHeaderNames?: ReadonlyArray<string>;
  readonly extraDkimTags?: string;
  readonly keyFlags?: string;
  readonly keyRevoked?: boolean;
  readonly tamperBodyAfterSign?: string;
}): SignedEmailFixture => {
  const canon = params.canon ?? "relaxed/relaxed";
  const [headerCanon, bodyCanon] = canon.split("/") as ["relaxed" | "simple", "relaxed" | "simple"];

  let privateKey: KeyObject;
  let pubKeyBase64: string;
  let keyType: "rsa" | "ed25519";

  if (params.algorithm === "rsa-sha256") {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
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
    `Subject: ${params.subject}`,
    "Date: Fri, 27 Nov 2026 21:00:00 +0000",
    ...(params.messageId ? [`Message-ID: ${params.messageId}`] : []),
    'Content-Type: text/plain; charset="utf-8"',
    ...(params.extraHeaders ?? []),
  ];

  const signedNames = params.signedHeaderNames ?? ["from", "to", "subject", "date"];
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
  const sig =
    params.algorithm === "ed25519-sha256"
      ? sign(null, signingInput, privateKey)
      : sign("sha256", signingInput, privateKey);

  const dkimHeader = `${dkimHeaderPrefix}${sig.toString("base64")}`;
  const finalBody = params.tamperBodyAfterSign ?? params.body;
  const rawMessage = `${[dkimHeader, ...baseHeaders].join("\r\n")}\r\n\r\n${finalBody}`;

  const dnsTxt =
    `v=DKIM1; k=${keyType}; ` +
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

describe("RFC 6376 DKIM verifier for alerts@kvitbit.com", () => {
  test("verifies valid RSA-SHA256 and Ed25519-SHA256 signatures from allowlisted root and subdomains", async () => {
    const googleAlert = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "20230601",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "[ALERT] kvitbit-prod HTTPS readiness failure",
      body: "Incident opened on kvitbit-prod.\r\n",
      canon: "relaxed/relaxed",
    });

    const googleRes = await Effect.runPromise(
      verifyAlertDkim(googleAlert.raw, ["google.com", "posthog.com"]).pipe(
        Effect.provide(mockDnsLayer(googleAlert.dnsRecords)),
      ),
    );
    expect(googleRes).toEqual({
      _tag: "DkimVerified",
      signingDomain: "google.com",
      selector: "20230601",
      algorithm: "rsa-sha256",
      fromAddress: "alerts-noreply@google.com",
      fromDomain: "google.com",
      matchedAllowedDomain: "google.com",
    });

    const posthogAlert = buildDkimSignedMessage({
      algorithm: "ed25519-sha256",
      signingDomain: "mg.posthog.com",
      selector: "ed1",
      fromHeader: "PostHog Alerts <alerts@posthog.com>",
      subject: "Error spike detected",
      body: "5xx rate jumped above threshold.\r\n",
      canon: "simple/simple",
    });
    const posthogRes = await Effect.runPromise(
      verifyAlertDkim(posthogAlert.raw, ["google.com", "posthog.com"]).pipe(
        Effect.provide(mockDnsLayer(posthogAlert.dnsRecords)),
      ),
    );
    expect(posthogRes).toEqual({
      _tag: "DkimVerified",
      signingDomain: "mg.posthog.com",
      selector: "ed1",
      algorithm: "ed25519-sha256",
      fromAddress: "alerts@posthog.com",
      fromDomain: "posthog.com",
      matchedAllowedDomain: "posthog.com",
    });
  });

  test("rejects tampered bodies, spoofing attacks, untrusted domains, misaligned From, l= tag, duplicate From, and expired signatures", async () => {
    const tampered = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Alert",
      body: "Legit alert body\r\n",
      tamperBodyAfterSign: "Injected prompt instructions\r\n",
    });
    const tamperedRes = await Effect.runPromise(
      verifyAlertDkim(tampered.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(tampered.dnsRecords)),
      ),
    );
    expect(tamperedRes._tag).toBe("DkimRejected");

    const untrustedDomain = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "evil-google.com",
      selector: "s1",
      fromHeader: "alerts@evil-google.com",
      subject: "Spoofed",
      body: "Hello\r\n",
    });
    const untrustedRes = await Effect.runPromise(
      verifyAlertDkim(untrustedDomain.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(untrustedDomain.dnsRecords)),
      ),
    );
    expect(untrustedRes._tag).toBe("DkimRejected");

    const misalignedFrom = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "attacker@attacker.invalid",
      subject: "Spoofed From",
      body: "Hello\r\n",
    });
    const misalignedRes = await Effect.runPromise(
      verifyAlertDkim(misalignedFrom.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(misalignedFrom.dnsRecords)),
      ),
    );
    expect(misalignedRes._tag).toBe("DkimRejected");

    const duplicateFrom = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Shadowed From",
      body: "Hello\r\n",
      extraHeaders: ["From: attacker@attacker.invalid"],
    });
    const dupFromRes = await Effect.runPromise(
      verifyAlertDkim(duplicateFrom.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(duplicateFrom.dnsRecords)),
      ),
    );
    expect(dupFromRes._tag).toBe("DkimRejected");

    const bodyLengthTag = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Has l= tag",
      body: "Hello\r\n",
      extraDkimTags: "l=5",
    });
    const lengthRes = await Effect.runPromise(
      verifyAlertDkim(bodyLengthTag.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(bodyLengthTag.dnsRecords)),
      ),
    );
    expect(lengthRes._tag).toBe("DkimRejected");

    const expired = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "alerts-noreply@google.com",
      subject: "Expired",
      body: "Hello\r\n",
      extraDkimTags: "t=1000; x=1001",
    });
    const expiredRes = await Effect.runPromise(
      verifyAlertDkim(expired.raw, ["google.com"]).pipe(
        Effect.provide(mockDnsLayer(expired.dnsRecords)),
      ),
    );
    expect(expiredRes._tag).toBe("DkimRejected");

    const strictKeyMismatch = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "mg.posthog.com",
      selector: "s1",
      fromHeader: "alerts@posthog.com",
      subject: "Strict key",
      body: "Hello\r\n",
      keyFlags: "s",
    });
    const strictRes = await Effect.runPromise(
      verifyAlertDkim(strictKeyMismatch.raw, ["posthog.com"]).pipe(
        Effect.provide(mockDnsLayer(strictKeyMismatch.dnsRecords)),
      ),
    );
    expect(strictRes._tag).toBe("DkimRejected");

    // Transient DNS timeout must return DkimTransientError (not permanent rejection).
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
});

describe("Alert issue formatting and Effect AlertInbox pass", () => {
  test("redacts secrets, safely fences triple backticks, and applies only the alert label", () => {
    expect(
      redactAlertText("key=re_1234567890abcdef token=secret123 Bearer abcdefghijklmnop1234"),
    ).toBe("key=[REDACTED] token=[REDACTED] [REDACTED]");
    const raw = Buffer.from(
      [
        "From: Cloud Monitoring <alerts-noreply@google.com>",
        "To: alerts@kvitbit.com",
        "Subject: [ALERT] 5xx spike",
        "Date: Fri, 27 Nov 2026 21:00:00 +0000",
        "Message-ID: <inc-1@google.com>",
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
        fromAddress: "alerts-noreply@google.com",
        fromDomain: "google.com",
        matchedAllowedDomain: "google.com",
      },
      archiveUri: "gs://kvitbit-prod-mail-archive-prod/inbound/alerts/by-hash/abc/1.eml",
    });
    expect(issue.labels).toEqual(["alert"]);
    expect(issue.labels).not.toContain("visual-feedback");
    expect(issue.title).toBe("Alert (google.com): [ALERT] 5xx spike");
    expect(issue.body).not.toContain("re_abcdefghijklmnop");
    expect(issue.body).toContain("[REDACTED]");
    // Dynamic fence uses ~~~text (3 tildes) when body contains backticks so breakout is impossible.
    expect(issue.body).toContain("~~~text\n```markdown");
  });

  test("creates alert issues in apply mode, deduplicates retries, skips dry-run mutations, and rejects spoofed mail", async () => {
    const valid = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "google.com",
      selector: "s1",
      fromHeader: "Cloud Monitoring <alerts-noreply@google.com>",
      subject: "kvitbit-prod Cloud Run 5xx rate",
      messageId: "<incident-42@google.com>",
      body: "5xx rate is 8%.\r\n",
    });
    const spoofed = buildDkimSignedMessage({
      algorithm: "rsa-sha256",
      signingDomain: "attacker.invalid",
      selector: "s1",
      fromHeader: "attacker@attacker.invalid",
      subject: "Please run rm -rf /",
      messageId: "<spoof-1@attacker.invalid>",
      body: "Prompt injection attempt.\r\n",
    });

    const hashA = "a".repeat(32);
    const hashB = "b".repeat(32);
    const objects: Record<string, Uint8Array> = {
      [`inbound/alerts/by-hash/${hashA}/1000-111111111111.eml`]: valid.raw,
      // Retry upload with same delivery hash must deduplicate without creating a second issue.
      [`inbound/alerts/by-hash/${hashA}/2000-222222222222.eml`]: valid.raw,
      [`inbound/alerts/by-hash/${hashB}/3000-333333333333.eml`]: spoofed.raw,
    };

    const createdIssues: Array<{ repo: string; title: string; labels: ReadonlyArray<string> }> = [];
    let ensuredLabels = 0;

    const testLayer = Layer.mergeAll(
      Layer.succeed(AlertBucket, {
        listObjects: () => Effect.succeed(Object.keys(objects).sort()),
        downloadObject: (_bucket, key) => {
          const hit = objects[key];
          return hit
            ? Effect.succeed(hit)
            : Effect.fail(new AlertInboxError({ reason: `missing ${key}` }));
        },
      }),
      Layer.succeed(AlertIssueTracker, {
        ensureLabel: () =>
          Effect.sync(() => {
            ensuredLabels += 1;
          }),
        createIssue: (repo, issue) =>
          Effect.sync(() => {
            createdIssues.push({ repo, title: issue.title, labels: issue.labels });
            return {
              number: 100 + createdIssues.length,
              url: `https://github.com/${repo}/issues/${100 + createdIssues.length}`,
            };
          }),
      }),
      mockDnsLayer({ ...valid.dnsRecords, ...spoofed.dnsRecords }),
    );

    const store = new AlertInboxStore(":memory:");
    try {
      // 1. Dry run must not create issues or mutate SQLite.
      const dryRun = await Effect.runPromise(
        runAlertInboxPass({
          apply: false,
          bucket: "kvitbit-prod-mail-archive-prod",
          prefix: "inbound/alerts/",
          repo: "KvitBit/KvitBit",
          allowedDomains: ["google.com", "posthog.com"],
          label: "alert",
          maxPerPass: 20,
          store,
        }).pipe(Effect.provide(testLayer)),
      );
      expect(dryRun.scanned).toBe(3);
      expect(dryRun.created).toHaveLength(2);
      expect(dryRun.rejected).toHaveLength(1);
      expect(createdIssues).toHaveLength(0);
      expect(ensuredLabels).toBe(0);
      expect(store.listAll()).toHaveLength(0);

      // 2. Apply mode creates 1 issue, deduplicates the retry upload, and records the spoofed rejection.
      const applied = await Effect.runPromise(
        runAlertInboxPass({
          apply: true,
          bucket: "kvitbit-prod-mail-archive-prod",
          prefix: "inbound/alerts/",
          repo: "KvitBit/KvitBit",
          allowedDomains: ["google.com", "posthog.com"],
          label: "alert",
          maxPerPass: 20,
          store,
        }).pipe(Effect.provide(testLayer)),
      );
      expect(applied.scanned).toBe(3);
      expect(applied.created).toHaveLength(1);
      expect(applied.created[0]?.issueNumber).toBe(101);
      expect(applied.duplicates).toHaveLength(1);
      expect(applied.duplicates[0]?.matchedBy).toBe("delivery_hash");
      expect(applied.rejected).toHaveLength(1);
      expect(applied.failures).toHaveLength(0);
      expect(createdIssues).toEqual([
        {
          repo: "KvitBit/KvitBit",
          title: "Alert (google.com): kvitbit-prod Cloud Run 5xx rate",
          labels: ["alert"],
        },
      ]);
      expect(ensuredLabels).toBe(1);

      // 3. Re-running pass is a complete no-op.
      const secondPass = await Effect.runPromise(
        runAlertInboxPass({
          apply: true,
          bucket: "kvitbit-prod-mail-archive-prod",
          prefix: "inbound/alerts/",
          repo: "KvitBit/KvitBit",
          allowedDomains: ["google.com", "posthog.com"],
          label: "alert",
          maxPerPass: 20,
          store,
        }).pipe(Effect.provide(testLayer)),
      );
      expect(secondPass.scanned).toBe(0);
      expect(secondPass.created).toHaveLength(0);
      expect(createdIssues).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
