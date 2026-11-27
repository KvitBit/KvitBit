import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BRANDING_IMAGE_MAX_BYTES } from "@kvitbit/api-contract";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let base: string;

/** Minimal valid 1x1 PNG (starts with the 8-byte PNG signature). */
const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

beforeEach(async () => {
  h = makeHarness();
  owner = h.addUser("Olga");
  const member = await h.createWorkspace(owner, { name: "Alfa s.r.o." });
  base = `/api/v1/workspaces/${member.workspaceId}/branding`;
});

afterEach(async () => {
  await h.dispose();
});

const upload = (
  image: "logo" | "stamp",
  bytes: Uint8Array,
  contentType: string,
  fieldName = "file",
) => {
  const form = new FormData();
  form.append(fieldName, new Blob([new Uint8Array(bytes)], { type: contentType }), `${image}.png`);
  return h.fetch(`${base}/${image}`, {
    method: "PUT",
    headers: as.mobile(owner),
    body: form,
  });
};

describe("branding group", () => {
  test("getBranding and updateBranding with If-Match and resolvedTheme", async () => {
    const getRes = await h.fetch(base, { headers: as.mobile(owner) });
    expect(getRes.status).toBe(200);
    const initial = (await getRes.json()) as {
      pdfTemplate: string;
      theme: unknown;
      resolvedTheme: unknown;
      revision: number;
    };
    expect(initial.pdfTemplate).toBe("classic");
    expect(initial.theme).toBeNull();
    expect(initial.resolvedTheme).toBeNull();
    expect(getRes.headers.get("etag")).toBe(`"${initial.revision}"`);

    // Missing If-Match -> 428
    const missing = await h.fetch(base, {
      ...json({ pdfTemplate: "modern_minimal" }),
      method: "PATCH",
      headers: { "content-type": "application/json", ...as.mobile(owner) },
    });
    expect(missing.status).toBe(428);

    // Stale If-Match -> 412
    const stale = await h.fetch(base, {
      ...json({ pdfTemplate: "modern_minimal" }),
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...as.mobile(owner),
        "if-match": `"${initial.revision + 4}"`,
      },
    });
    expect(stale.status).toBe(412);

    // Invalid MaterialThemeBuilder JSON -> 422 theme.json_invalid
    const badTheme = await h.fetch(base, {
      ...json({ theme: { _tag: "MaterialThemeBuilder", json: { bad: true } } }),
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...as.mobile(owner),
        "if-match": `"${initial.revision}"`,
      },
    });
    expect(badTheme.status).toBe(422);
    const badBody = (await badTheme.json()) as { issues: Array<{ code: string }> };
    expect(badBody.issues[0]?.code).toBe("theme.json_invalid");

    // Valid update with Preset theme populates resolvedTheme with all 6 schemes
    const ok = await h.fetch(base, {
      ...json({
        pdfTemplate: "modern_minimal",
        accentColor: "#0F5D42",
        footerText: "Děkujeme za spolupráci",
        theme: { _tag: "Preset", id: "forest" },
      }),
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...as.mobile(owner),
        "if-match": `"${initial.revision}"`,
      },
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as {
      pdfTemplate: string;
      resolvedTheme: { schemes: Record<string, { roles: Record<string, string> }> } | null;
      revision: number;
    };
    expect(updated.pdfTemplate).toBe("modern_minimal");
    expect(ok.headers.get("etag")).toBe(`"${updated.revision}"`);
    expect(updated.resolvedTheme).not.toBeNull();
    expect(Object.keys(updated.resolvedTheme?.schemes ?? {}).sort()).toEqual([
      "dark",
      "darkHigh",
      "darkMedium",
      "light",
      "lightHigh",
      "lightMedium",
    ]);

    // Subsequent GET also returns resolvedTheme
    const afterGet = (await (await h.fetch(base, { headers: as.mobile(owner) })).json()) as {
      resolvedTheme: unknown;
    };
    expect(afterGet.resolvedTheme).toEqual(updated.resolvedTheme);
  });

  test("putImage, getImage (ETag + private cache), removeImage, and validation errors", async () => {
    // 404 before upload
    const missing = await h.fetch(`${base}/logo`, { headers: as.mobile(owner) });
    expect(missing.status).toBe(404);

    // Wrong field name -> 422
    const wrongField = await upload("logo", VALID_PNG, "image/png", "other");
    expect(wrongField.status).toBe(422);

    // SVG / wrong magic bytes -> 422
    const svg = await upload("logo", new TextEncoder().encode("<svg></svg>"), "image/svg+xml");
    expect(svg.status).toBe(422);
    const badMagic = await upload("logo", new TextEncoder().encode("not a png"), "image/png");
    expect(badMagic.status).toBe(422);

    // Oversized (> 2 MB) -> 413 PayloadTooLarge
    const tooBig = new Uint8Array(BRANDING_IMAGE_MAX_BYTES + 1024);
    tooBig.set(VALID_PNG, 0);
    const oversized = await upload("logo", tooBig, "image/png");
    expect(oversized.status).toBe(413);

    // Valid PNG upload -> 200 ImageRef
    const putRes = await upload("logo", VALID_PNG, "image/png");
    expect(putRes.status).toBe(200);
    const ref = (await putRes.json()) as { contentType: string; bytes: number; sha256: string };
    expect(ref.contentType).toBe("image/png");
    expect(ref.bytes).toBe(VALID_PNG.byteLength);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Download returns exact bytes + strong ETag + private cache + nosniff
    const getRes = await h.fetch(`${base}/logo`, { headers: as.mobile(owner) });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(getRes.headers.get("etag")).toBe(`"${ref.sha256}"`);
    expect(getRes.headers.get("cache-control")).toBe("private, max-age=300");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getRes.headers.get("content-length")).toBe(String(VALID_PNG.byteLength));
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(VALID_PNG);

    // Remove -> 204, then GET -> 404
    const delRes = await h.fetch(`${base}/logo`, { method: "DELETE", headers: as.mobile(owner) });
    expect(delRes.status).toBe(204);
    const afterDel = await h.fetch(`${base}/logo`, { headers: as.mobile(owner) });
    expect(afterDel.status).toBe(404);
  });

  test("previewPdf streams inline PDF with no-store and nosniff", async () => {
    const res = await h.fetch(`${base}/preview-pdf`, {
      ...json({
        branding: { pdfTemplate: "modern_minimal", accentColor: "#1D4ED8" },
        kind: "invoice",
        language: "cs",
      }),
      method: "POST",
      headers: { "content-type": "application/json", ...as.mobile(owner) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
