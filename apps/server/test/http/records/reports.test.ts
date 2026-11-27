import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReportsModule } from "@kvitbit/core";
import {
  type ContactId,
  Contacts,
  CurrencyCode,
  CurrentCaller,
  Documents,
  type ExportId,
  IsoDate,
  type MemberCaller,
} from "@kvitbit/domain/contract";
import { BlobStorage } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Stream } from "effect";
import { captureAnalytics } from "../../analytics-fixture";
import { as, type Harness, makeHarness, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let wsBase: string;
let analytics: ReturnType<typeof captureAnalytics>;

beforeEach(async () => {
  analytics = captureAnalytics();
  h = makeHarness({
    analytics: analytics.layer,
    fixings: [
      {
        fixingDate: IsoDate.make("2026-11-23"),
        sequence: 226,
        rates: [
          {
            code: CurrencyCode.make("EUR"),
            quantity: 1,
            rate: BigDecimal.fromStringUnsafe("25.15"),
          },
        ],
      },
    ],
  });
  owner = h.addUser("Olga");
  member = await h.createWorkspace(owner);
  wsBase = `/api/v1/workspaces/${member.workspaceId}`;

  await h.run(
    Effect.gen(function* () {
      const contacts = yield* Contacts;
      const documents = yield* Documents;
      const contact = yield* contacts.save({
        name: "Odběratel a.s.",
        ico: "25596641",
        address: { city: "Brno", country: "CZ" },
        roles: ["customer"],
      });
      yield* documents.issue({
        input: {
          kind: "invoice",
          contact: contact.id as ContactId,
          issuedOn: IsoDate.make("2026-11-20"),
          due: { inDays: 14 },
          lines: [
            {
              description: "Služba",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("2000.00"),
            },
          ],
        },
      });
    }).pipe(Effect.provideService(CurrentCaller, member)),
  );
});

afterEach(async () => {
  await h.dispose();
});

describe("reports group", () => {
  test("dashboard, run (with and without groupBy), and export (csv and pdf)", async () => {
    const dash = await h.fetch(`${wsBase}/reports/dashboard?from=2026-11-01&to=2026-11-30`, {
      headers: as.mobile(owner),
    });
    expect(dash.status).toBe(200);
    const dashBody = (await dash.json()) as {
      period: { from: string; to: string };
      revenue: { amount: string; currency: string };
      cashflow: unknown[];
    };
    expect(dashBody.period).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(dashBody.revenue.currency).toBe("CZK");
    expect(dashBody.cashflow.length).toBe(12);

    const rev = await h.fetch(
      `${wsBase}/reports/revenue?from=2026-11-01&to=2026-11-30&groupBy=month`,
      { headers: as.mobile(owner) },
    );
    expect(rev.status).toBe(200);
    expect((await rev.json()) as Record<string, unknown>).toBeDefined();

    const vat = await h.fetch(`${wsBase}/reports/vat_summary?from=2026-11-01&to=2026-11-30`, {
      headers: as.mobile(owner),
    });
    expect(vat.status).toBe(200);

    const csv = await h.fetch(
      `${wsBase}/reports/revenue/export?format=csv&from=2026-11-01&to=2026-11-30`,
      { headers: as.mobile(owner) },
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    expect(csv.headers.get("cache-control")).toBe("private, no-store");
    expect((await csv.text()).length).toBeGreaterThan(0);

    const pdf = await h.fetch(
      `${wsBase}/reports/revenue/export?format=pdf&from=2026-11-01&to=2026-11-30`,
      { headers: as.mobile(owner) },
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(analytics.capture.mock.calls).toEqual([
      [
        {
          event: "report_exported",
          distinctId: owner.id,
          properties: { workspaceId: member.workspaceId, report: "revenue", format: "csv" },
        },
      ],
      [
        {
          event: "report_exported",
          distinctId: owner.id,
          properties: { workspaceId: member.workspaceId, report: "revenue", format: "pdf" },
        },
      ],
    ]);
  });

  test("fxRate returns CNB fixing for seeded currency and 422 for missing rate", async () => {
    const eur = await h.fetch(`${wsBase}/fx-rates/EUR?on=2026-11-23`, {
      headers: as.mobile(owner),
    });
    expect(eur.status).toBe(200);
    const body = (await eur.json()) as {
      currency: string;
      rate: string;
      quantity: number;
      fixingDate: string;
      source: string;
    };
    expect(body).toEqual({
      currency: "EUR",
      rate: "25.15",
      quantity: 1,
      fixingDate: "2026-11-23",
      source: "cnb",
    });

    const missing = await h.fetch(`${wsBase}/fx-rates/USD?on=2026-11-23`, {
      headers: as.mobile(owner),
    });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { issues: Array<{ code: string }> }).issues[0]?.code).toBe(
      "fx.rate_missing",
    );
  });

  test("startExport (202 + Idempotency-Key), getExport, and exportFile (409 while running, 200 ZIP when ready)", async () => {
    const started = await h.fetch(`${wsBase}/exports`, {
      method: "POST",
      headers: { ...as.mobile(owner), "idempotency-key": "export-key-0001" },
    });
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string; status: string };
    expect(job.status).toBe("running");

    const replay = await h.fetch(`${wsBase}/exports`, {
      method: "POST",
      headers: { ...as.mobile(owner), "idempotency-key": "export-key-0001" },
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(job);

    const status = await h.fetch(`${wsBase}/exports/${job.id}`, { headers: as.mobile(owner) });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(job);

    const notReady = await h.fetch(`${wsBase}/exports/${job.id}/file`, {
      headers: as.mobile(owner),
    });
    expect(notReady.status).toBe(409);

    // Complete the export job and upload its ZIP blob in TestCore
    const zipBytes = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    await h.run(
      Effect.gen(function* () {
        const blobs = yield* BlobStorage;
        const jobs = yield* ReportsModule.ExportJobs;
        const exportId = job.id as ExportId;
        const key = ReportsModule.exportBlobKey(member.workspaceId, exportId);
        yield* blobs.put(key, Stream.make(zipBytes), {
          contentType: "application/zip",
          maxBytes: 1024 * 1024,
        });
        yield* jobs.finish(member.workspaceId, exportId, zipBytes.byteLength);
      }),
    );

    const readyFile = await h.fetch(`${wsBase}/exports/${job.id}/file`, {
      headers: as.mobile(owner),
    });
    expect(readyFile.status).toBe(200);
    expect(readyFile.headers.get("content-type")).toBe("application/zip");
    expect(readyFile.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect(readyFile.headers.get("x-content-type-options")).toBe("nosniff");
    expect(readyFile.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await readyFile.arrayBuffer())).toEqual(zipBytes);

    const unknown = await h.fetch(`${wsBase}/exports/01900000-0000-7000-8000-000000000099`, {
      headers: as.mobile(owner),
    });
    expect(unknown.status).toBe(404);
  });
});
