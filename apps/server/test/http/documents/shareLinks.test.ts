import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DocumentFixtures } from "@kvitbit/core/testing";
import {
  ContactId,
  Contacts,
  CurrentCaller,
  type MemberCaller,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { deviceFromUserAgent } from "../../../src/http/groups/publicShare";
import { captureAnalytics } from "../../analytics-fixture";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";

// Minimal valid 1x1 PNG (8-byte signature + IHDR + IDAT + IEND)
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let contactId: ContactId;
let docsBase: string;
let analytics: ReturnType<typeof captureAnalytics>;

const invoiceInput = () => ({
  kind: "invoice",
  contact: contactId,
  lines: [{ description: "Služba", quantity: "1", unit: "ks", unitPrice: "1000" }],
});

const issueDoc = async () => {
  const init = json({ input: invoiceInput() });
  const res = await h.fetch(`${docsBase}/issue`, {
    ...init,
    method: "POST",
    headers: { ...(init.headers as Record<string, string>), ...as.mobile(owner) },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; number: string };
};

const tokenFromUrl = (url: string) => {
  const token = url.split("/").pop();
  expect(token).toBeTruthy();
  return token as string;
};

describe("deviceFromUserAgent", () => {
  test("classifies tablet, mobile, desktop, and unknown user agents", () => {
    expect(deviceFromUserAgent(undefined)).toBe("unknown");
    expect(deviceFromUserAgent("   ")).toBe("unknown");
    expect(deviceFromUserAgent("curl/8.5.0")).toBe("unknown");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toBe("tablet");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("tablet");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("mobile");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("mobile");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
    expect(
      deviceFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
  });
});

describe("shareLinks and publicShare groups", () => {
  beforeEach(async () => {
    analytics = captureAnalytics();
    h = makeHarness({ analytics: analytics.layer });
    await h.run(TestClock.setTime(TEST_NOW));
    owner = h.addUser("Olga");
    member = await h.createWorkspace(owner);
    docsBase = `/api/v1/workspaces/${member.workspaceId}/documents`;
    const contact = await h.run(
      Effect.flatMap(Contacts, (c) =>
        c.save({
          name: "Klient s.r.o.",
          ico: "25596641",
          address: { city: "Praha", country: "CZ" },
          roles: ["customer"],
        }),
      ).pipe(Effect.provideService(CurrentCaller, member)),
    );
    contactId = ContactId.make(contact.id as string);
  });

  afterEach(async () => {
    await h.dispose();
  });
  test("create refuses drafts with 409; issued documents return an idempotent share URL", async () => {
    const draftRes = await h.fetch(docsBase, {
      ...json(invoiceInput()),
      method: "POST",
      headers: { "content-type": "application/json", ...as.mobile(owner) },
    });
    const draft = (await draftRes.json()) as { id: string };

    const draftLink = await h.fetch(`${docsBase}/${draft.id}/share-link`, {
      method: "PUT",
      headers: as.mobile(owner),
    });
    expect(draftLink.status).toBe(409);

    const doc = await issueDoc();
    const first = await h.fetch(`${docsBase}/${doc.id}/share-link`, {
      method: "PUT",
      headers: as.mobile(owner),
    });
    expect(first.status).toBe(200);
    const created = (await first.json()) as { url: string };
    expect(created.url).toContain("/s/");

    const second = await h.fetch(`${docsBase}/${doc.id}/share-link`, {
      method: "PUT",
      headers: as.mobile(owner),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(created);
  });

  test("publicShare open and pdf record device-classified events, respect viewerIsIssuer, and revoke invalidates", async () => {
    const doc = await issueDoc();
    const linkRes = await h.fetch(`${docsBase}/${doc.id}/share-link`, {
      method: "PUT",
      headers: as.mobile(owner),
    });
    const { url } = (await linkRes.json()) as { url: string };
    const token = tokenFromUrl(url);

    // Anonymous mobile visitor opens the share page
    const mobileOpen = await h.fetch(`/api/v1/share/${token}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      },
    });
    expect(mobileOpen.status).toBe(200);
    const shared = (await mobileOpen.json()) as {
      number: string;
      viewerIsIssuer: boolean;
    };
    expect(shared.number).toBe(doc.number);
    expect(shared.viewerIsIssuer).toBe(false);
    expect(analytics.capture.mock.calls.slice(1)).toEqual([
      [
        {
          event: "share_link_created",
          distinctId: owner.id,
          properties: { workspaceId: member.workspaceId },
        },
      ],
      [
        {
          event: "share_link_opened",
          distinctId: expect.stringMatching(/^[a-f\d-]{36}$/),
          options: { process_person_profile: false },
        },
      ],
    ]);

    // Anonymous desktop visitor downloads the PDF in English
    const desktopPdf = await h.fetch(`/api/v1/share/${token}/pdf?language=en`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0",
      },
    });
    expect(desktopPdf.status).toBe(200);
    expect(desktopPdf.headers.get("content-type")).toBe("application/pdf");
    expect(desktopPdf.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect(desktopPdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(desktopPdf.headers.get("cache-control")).toBe("private, no-store");
    expect((await desktopPdf.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const renders = await h.run(Effect.flatMap(DocumentFixtures, (f) => Ref.get(f.renders)));
    expect(renders.at(-1)?.options.language).toBe("en");

    // Signed-in issuer views the page -> viewerIsIssuer: true, no event recorded
    const issuerOpen = await h.fetch(`/api/v1/share/${token}`, {
      headers: {
        ...as.mobile(owner),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/120.0",
      },
    });
    expect(issuerOpen.status).toBe(200);
    expect(((await issuerOpen.json()) as { viewerIsIssuer: boolean }).viewerIsIssuer).toBe(true);

    // Member lists share views with paging
    const viewsRes = await h.fetch(`${docsBase}/${doc.id}/share-link/views?limit=10`, {
      headers: as.mobile(owner),
    });
    expect(viewsRes.status).toBe(200);
    const page = (await viewsRes.json()) as {
      items: Array<{ kind: string; device: string }>;
    };
    expect(page.items).toHaveLength(2);
    expect(page.items.map((e) => ({ kind: e.kind, device: e.device }))).toEqual([
      { kind: "download", device: "desktop" },
      { kind: "view", device: "mobile" },
    ]);

    // Revoke link -> 204; subsequent visitor opens return 404
    const revoked = await h.fetch(`${docsBase}/${doc.id}/share-link`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(revoked.status).toBe(204);

    const afterRevoke = await h.fetch(`/api/v1/share/${token}`);
    expect(afterRevoke.status).toBe(404);

    const unknown = await h.fetch("/api/v1/share/not-a-valid-token");
    expect(unknown.status).toBe(404);
  });

  test("publicShare logo returns 404 when absent and serves image with ETag and cache headers when set", async () => {
    const doc = await issueDoc();
    const { url } = (await (
      await h.fetch(`${docsBase}/${doc.id}/share-link`, {
        method: "PUT",
        headers: as.mobile(owner),
      })
    ).json()) as { url: string };
    const token = tokenFromUrl(url);

    const missing = await h.fetch(`/api/v1/share/${token}/logo`);
    expect(missing.status).toBe(404);

    // Upload a logo via Workspaces.setBrandingImage
    await h.run(
      Effect.flatMap(Workspaces, (w) =>
        w.setBrandingImage("logo", {
          contentType: "image/png",
          bytes: Stream.make(TINY_PNG),
        }),
      ).pipe(Effect.provideService(CurrentCaller, member)),
    );

    const logoRes = await h.fetch(`/api/v1/share/${token}/logo`);
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers.get("content-type")).toBe("image/png");
    expect(logoRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logoRes.headers.get("cache-control")).toBe("private, max-age=300");
    expect(logoRes.headers.get("content-length")).toBe(String(TINY_PNG.byteLength));
    const expectedEtag = `"${createHash("sha256").update(TINY_PNG).digest("hex")}"`;
    expect(logoRes.headers.get("etag")).toBe(expectedEtag);
    expect(new Uint8Array(await logoRes.arrayBuffer())).toEqual(TINY_PNG);
  });
});
