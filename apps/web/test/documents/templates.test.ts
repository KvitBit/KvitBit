import { describe, expect, test } from "bun:test";
import { TemplateId } from "@kvitbit/domain";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { routes as demoRoutes } from "../../src/demo/documents";
import { match } from "../../src/demo/router";
import { DEMO_WORKSPACE } from "../../src/demo/shell";
import { TemplateViewData } from "../../src/page/documents/shared";
import * as Templates from "../../src/page/documents/templates";
import { ctxFor, renderPath, WS } from "../support";
import { jsonDocument, runCommand, sampleProforma, sessionWithRole } from "./fixtures";

const requestKeyPattern = /^[0-9a-f-]{36}$/;

const TPL_ID = TemplateId.make("0193a000-0000-7000-8000-000000000801");

const sampleTemplate = Effect.runSync(
  Schema.decodeEffect(TemplateViewData)({
    id: TPL_ID,
    name: "Měsíční podpora webu",
    revision: 2,
    archived: false,
    input: {
      name: "Měsíční podpora webu",
      kind: "invoice",
      contact: "0193a000-0000-7000-8000-000000000201",
      currency: "CZK",
      due: { inDays: 14 },
      paymentMethod: "bank_transfer",
      pricesIncludeVat: false,
      lines: [
        {
          description: "Podpora",
          quantity: BigDecimal.fromBigInt(1n),
          unit: "měs",
          unitPrice: BigDecimal.fromBigInt(12000n),
          vat: "standard",
        },
      ],
    },
    schedule: {
      id: "0193a000-0000-7000-8000-000000000811",
      every: { months: 1 },
      startOn: "2026-01-01",
      endOn: null,
      issueAs: "invoice",
      autoSend: true,
      nextOccurrence: "2026-12-01",
      paused: true,
      pausedReason: "fx.rate_missing",
      pausedError: null,
    },
  }),
);

describe("Templates & Recurring page (Screen 12)", () => {
  const listRoute: Templates.Route = { _tag: "Templates", ws: WS };
  const editRoute: Templates.Route = { _tag: "Template", ws: WS, id: TPL_ID, tab: "schedule" };

  test("init loads templates list and localizes titles", () => {
    const ctxCs = ctxFor(listRoute, { locale: "cs" });
    const ctxEn = ctxFor(listRoute, { locale: "en" });
    const res = Templates.init(listRoute, ctxCs);
    expect(res.model.data._tag).toBe("Loading");
    expect(res.commands?.length).toBe(1);
    expect(Templates.title(res.model, ctxCs)).toBe("Šablony a pravidelná fakturace");
    expect(Templates.title(res.model, ctxEn)).toBe("Templates & Recurring");
  });

  test("stale-seq safety, template hydration, schedule update and resume", () => {
    const ctx = ctxFor(editRoute, { locale: "en" });
    const { model } = Templates.init(editRoute, ctx);
    const stale = Templates.update(
      model,
      Templates.Message.Loaded({
        seq: 5,
        data: {
          templates: [sampleTemplate],
          contacts: [],
          activeTemplate: sampleTemplate,
          runs: [],
        },
      }),
      ctx,
    );
    expect(stale.model.data._tag).toBe("Loading");

    const loaded = Templates.update(
      stale.model,
      Templates.Message.Loaded({
        seq: 1,
        data: {
          templates: [sampleTemplate],
          contacts: [],
          activeTemplate: sampleTemplate,
          runs: [],
        },
      }),
      ctx,
    );
    expect(loaded.model.name).toBe("Měsíční podpora webu");
    expect(loaded.model.cadenceUnit).toBe("months");
    expect(loaded.model.autoSend).toBe(true);

    const resumed = Templates.update(
      loaded.model,
      Templates.Message.ClickedResumeSchedule({ templateId: TPL_ID }),
      ctx,
    );
    expect(resumed.model.busy).toBe(true);
    expect(resumed.commands?.length).toBe(1);

    const openArchive = Templates.update(
      loaded.model,
      Templates.Message.OpenedArchiveDialog(),
      ctx,
    );
    expect(openArchive.model.archiveDialogOpen).toBe(true);
  });

  test("demo routes cover dashboard, documents, payments, share links, and templates", () => {
    const wsId = DEMO_WORKSPACE.id;
    expect(match(demoRoutes, "GET", `/api/v1/workspaces/${wsId}/reports/dashboard`)).toBeDefined();
    expect(match(demoRoutes, "GET", `/api/v1/workspaces/${wsId}/documents`)).toBeDefined();
    expect(match(demoRoutes, "POST", `/api/v1/workspaces/${wsId}/payments`)).toBeDefined();
    expect(match(demoRoutes, "GET", `/api/v1/workspaces/${wsId}/templates`)).toBeDefined();
    expect(match(demoRoutes, "POST", `/api/v1/workspaces/${wsId}/contacts/from-ico`)).toBeDefined();
  });

  test("using a template as a draft preserves its request key when the first reply is lost", async () => {
    const ctx = ctxFor(listRoute);
    const open = Templates.init(listRoute, ctx);
    const message = Templates.Message.ClickedUseTemplate({ templateId: TPL_ID });
    const accountant = ctxFor(listRoute, { session: sessionWithRole("accountant") });
    expect(Templates.update(open.model, message, accountant).commands).toBeUndefined();

    const mint = Templates.update(open.model, message, ctx);
    const first = Templates.update(mint.model, await runCommand({ commands: mint.commands }), ctx);
    const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
    const fetch = async (request: Request) => {
      requests.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("idempotency-key"),
        body: await request.json(),
      });
      if (requests.length === 1) throw new TypeError("lost template reply");
      return jsonDocument({ ...sampleProforma, status: "draft", number: null }, 201);
    };
    const failed = Templates.update(
      first.model,
      await runCommand({ commands: first.commands, fetch }),
      ctx,
    );
    const retry = Templates.update(failed.model, message, ctx);
    const done = Templates.update(
      retry.model,
      await runCommand({ commands: retry.commands, fetch }),
      ctx,
    );
    expect(requests[0]?.path).toEndWith(`/${TPL_ID}/documents`);
    expect(requests[0]?.key).toMatch(requestKeyPattern);
    expect(requests[0]?.body).toEqual({ as: "draft" });
    expect(requests[1]).toEqual(requests[0]);
    expect(done.outMessage?._tag).toBe("Navigate");
  });

  test("renders cs and en via SSR", async () => {
    const cs = await renderPath(`/w/${WS}/templates`, { locale: "cs" });
    expect(cs.html).toContain("Šablony a pravidelná fakturace");
    const en = await renderPath(`/w/${WS}/templates`, { locale: "en" });
    expect(en.html).toContain("Templates");
  });
});
