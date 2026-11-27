import { describe, expect, test } from "bun:test";
import { DashboardView } from "@kvitbit/domain";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Dashboard from "../../src/page/documents/dashboard";
import { DocumentSummaryData } from "../../src/page/documents/shared";
import { ctxFor, renderPath, WS } from "../support";
import { runCommand, sessionWithRole } from "./fixtures";

const bd = (n: number) => BigDecimal.fromBigInt(BigInt(n));

const sampleDashboard = Effect.runSync(
  Schema.decodeEffect(DashboardView)({
    period: { from: "2026-01-01", to: "2026-11-24" },
    revenue: { amount: bd(500000), currency: "CZK" },
    unpaid: { amount: bd(87120), currency: "CZK" },
    overdue: { total: { amount: bd(87120), currency: "CZK" }, count: 1 },
    expenses: { amount: bd(120000), currency: "CZK" },
    incompleteExpenses: 2,
    cashflow: [
      {
        month: "2026-10",
        in: { amount: bd(70000), currency: "CZK" },
        out: { amount: bd(20000), currency: "CZK" },
        net: { amount: bd(50000), currency: "CZK" },
      },
      {
        month: "2026-11",
        in: { amount: bd(90000), currency: "CZK" },
        out: { amount: bd(25000), currency: "CZK" },
        net: { amount: bd(65000), currency: "CZK" },
      },
    ],
  }),
);

const sampleRecent = Effect.runSync(
  Schema.decodeEffect(Schema.Array(DocumentSummaryData))([
    {
      id: "0193a000-0000-7000-8000-000000000601",
      kind: "invoice",
      number: "2026-0041",
      status: "issued",
      locked: false,
      settlement: "unpaid",
      overdue: true,
      revision: 1,
      contact: { id: "0193a000-0000-7000-8000-000000000201", name: "Alza.cz a.s." },
      issuedOn: "2026-10-15",
      dueOn: "2026-10-29",
      total: { amount: bd(87120), currency: "CZK" },
    },
  ]),
);

describe("Dashboard page (Screen 08)", () => {
  const route: Dashboard.Route = { _tag: "Dashboard", ws: WS };

  test("init loads dashboard and recent documents", () => {
    const options = { locale: "cs", _tag: "SignIn" } as const;
    const ctx = ctxFor(route, options);
    const res = Dashboard.init(route, ctx);
    expect(res.model.dashboard._tag).toBe("Loading");
    expect(res.model.recent._tag).toBe("Loading");
    expect(res.commands?.length).toBe(2);
    expect(Dashboard.title(res.model, ctx)).toBe("Přehled");
    expect(Dashboard.title(res.model, ctxFor(route, { locale: "en" }))).toBe("Dashboard");
  });

  test("stale sequence replies are dropped", () => {
    const ctx = ctxFor(route);
    const { model } = Dashboard.init(route, ctx);
    // seq is 1; a reply for seq 99 must be ignored
    const stale = Dashboard.update(
      model,
      Dashboard.Message.LoadedDashboard({ seq: 99, data: sampleDashboard }),
      ctx,
    );
    expect(stale.model.dashboard._tag).toBe("Loading");

    // current seq 1 succeeds
    const loaded = Dashboard.update(
      stale.model,
      Dashboard.Message.LoadedDashboard({ seq: 1, data: sampleDashboard }),
      ctx,
    );
    expect(loaded.model.dashboard._tag).toBe("Loaded");
  });

  test("checklist dismissal and retry work cleanly", () => {
    const ctx = ctxFor(route);
    const { model } = Dashboard.init(route, ctx);
    const dismissed = Dashboard.update(model, Dashboard.Message.ClickedDismissChecklist(), ctx);
    expect(dismissed.model.checklistHidden).toBe(true);

    const retried = Dashboard.update(dismissed.model, Dashboard.Message.ClickedRetry(), ctx);
    expect(retried.model.dashboard._tag).toBe("Loading");
    expect(retried.commands?.length).toBe(2);
  });

  test("loaded state transitions with recent queue", () => {
    const ctx = ctxFor(route);
    const { model } = Dashboard.init(route, ctx);
    const step1 = Dashboard.update(
      model,
      Dashboard.Message.LoadedDashboard({ seq: 1, data: sampleDashboard }),
      ctx,
    );
    const step2 = Dashboard.update(
      step1.model,
      Dashboard.Message.LoadedRecent({ seq: 1, data: sampleRecent }),
      ctx,
    );
    expect(step2.model.recent._tag).toBe("Loaded");
  });

  test("renders cs and en via SSR", async () => {
    const cs = await renderPath(`/w/${WS}`, { locale: "cs" });
    expect(cs.html).toContain("Přehled");
    expect(cs.html).toContain("kb-checklist__cta");
    const en = await renderPath(`/w/${WS}`, { locale: "en" });
    expect(en.html).toContain("Dashboard");
    expect(en.html).toContain("Workspace setup");
  });
  test("recent documents load monetary values from the API response", async () => {
    const ctx = ctxFor(route);
    const { model, commands } = Dashboard.init(route, ctx);
    const recentCommand = commands?.[1];
    if (recentCommand === undefined) throw new Error("Missing recent documents command");
    const encode = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(DocumentSummaryData)));
    const message = await runCommand({
      commands: [recentCommand],
      fetch: (request) => {
        expect(new URL(request.url).pathname).toEndWith("/documents");
        return Response.json({ items: Effect.runSync(encode(sampleRecent)), nextCursor: null });
      },
    });
    const recent = Dashboard.update(model, message, ctx).model.recent;
    expect(recent._tag).toBe("Loaded");
    if (recent._tag !== "Loaded") throw new Error("Recent documents were not loaded");
    expect(encode(recent.data).pipe(Effect.runSync)).toEqual(
      encode(sampleRecent).pipe(Effect.runSync),
    );
  });

  test("accountants can read the dashboard without draft creation links", async () => {
    const { html } = await renderPath(`/w/${WS}`, {
      locale: "en",
      session: sessionWithRole("accountant"),
    });
    expect(html).toContain("Dashboard");
    expect(html).not.toContain("New invoice");
    expect(html).not.toContain("New proforma");
    expect(html).not.toContain(`/w/${WS}/documents/new`);
  });
});
