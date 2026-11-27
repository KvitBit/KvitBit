import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  IsoDate,
  TemplateId,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { idempotencyHeaders, ifMatchHeaders, uuidV7 } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { ReactElement } from "react";
import { ApiProvider, type ApiRunner } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { clientRoot } from "../../testing/client-root";
import { allText, hostTree } from "../../testing/element-tree";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { recordedOverlay } from "../../testing/recorded-overlay";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { TemplatesProbe } from "../test-probes";
import {
  buildScheduleEvery,
  buildTemplateInput,
  decodeTemplate,
  emptyTemplateForm,
  filterTemplates,
  occurrenceAt,
  previewOccurrences,
  scheduleStateOf,
} from "./model";

mock.module("expo-router", () => ({
  ...expoRouterStandIn(),
  router: {
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  },
}));

const { TemplatesListScreen } = await import("./templates-list-screen");
const { TemplateDetailScreen } = await import("./template-detail-screen");

const WS_ID = WorkspaceId.make("01937c7a-0000-7000-8000-000000000001");
const TPL_1 = TemplateId.make("01937c7a-0000-7000-8000-000000000401");
const TPL_2 = TemplateId.make("01937c7a-0000-7000-8000-000000000402");
const CONTACT_1 = "01937c7a-0000-7000-8000-000000000501";
const DOC_1 = "01937c7a-0000-7000-8000-000000000601";

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const TRAILING_SLASH_RE = /\/$/;

const activeTemplateWire = {
  id: TPL_1,
  name: "Monthly Hosting",
  revision: 2,
  archived: false,
  input: {
    name: "Monthly Hosting",
    kind: "invoice",
    contact: CONTACT_1,
    currency: "CZK",
    language: "cs",
    due: { inDays: 14 },
    paymentMethod: "bank_transfer",
    note: "Thank you",
    lines: [
      {
        description: "Cloud server",
        quantity: "1",
        unit: "month",
        unitPrice: "2500",
        vat: "standard",
      },
    ],
  },
  schedule: {
    id: "01937c7a-0000-7000-8000-000000000701",
    every: { months: 1 },
    startOn: "2026-11-01",
    endOn: null,
    issueAs: "invoice",
    autoSend: true,
    nextOccurrence: "2026-12-01",
    paused: false,
    pausedReason: null,
    pausedError: null,
  },
};

const pausedTemplateWire = {
  ...activeTemplateWire,
  id: TPL_2,
  name: "Quarterly Retainer",
  schedule: {
    ...activeTemplateWire.schedule,
    id: "01937c7a-0000-7000-8000-000000000702",
    every: { months: 3 },
    paused: true,
    pausedReason: "fx.rate_missing" as const,
  },
};

describe("templates & recurring model", () => {
  test("decodes template and classifies schedule states and filters", () => {
    const active = decodeTemplate(activeTemplateWire);
    const paused = decodeTemplate(pausedTemplateWire);
    const oneOff = decodeTemplate({ ...activeTemplateWire, schedule: null });

    if (active === null || paused === null || oneOff === null) {
      throw new Error("Expected all template fixtures to decode");
    }
    expect(scheduleStateOf(active.schedule)).toBe("active");
    expect(scheduleStateOf(paused.schedule)).toBe("paused");
    expect(scheduleStateOf(oneOff.schedule)).toBe("none");

    expect(filterTemplates([active, paused, oneOff], "active")).toHaveLength(1);
    expect(filterTemplates([active, paused, oneOff], "paused")).toHaveLength(1);
    expect(filterTemplates([active, paused, oneOff], "one_off")).toHaveLength(1);
  });

  test("previews only dates the schedule can represent", () => {
    expect(
      previewOccurrences({
        startOn: "9999-12-01",
        every: { months: 1 },
        endOn: "9999-12-31",
      }),
    ).toEqual([IsoDate.make("9999-12-01")]);
    expect(
      previewOccurrences({
        startOn: "9999-12-24",
        every: { weeks: 1 },
        endOn: "",
      }),
    ).toEqual([IsoDate.make("9999-12-24"), IsoDate.make("9999-12-31")]);
    expect(occurrenceAt(IsoDate.make("0001-01-31"), { months: 1 }, 1)).toBe(
      IsoDate.make("0001-02-28"),
    );
  });

  test("previews recurring dates with month-end clamping and endOn cutoff", () => {
    expect(occurrenceAt(IsoDate.make("2026-01-31"), { months: 1 }, 1)).toBe(
      IsoDate.make("2026-02-28"),
    );
    expect(occurrenceAt(IsoDate.make("2024-01-31"), { months: 1 }, 1)).toBe(
      IsoDate.make("2024-02-29"),
    );
    expect(occurrenceAt(IsoDate.make("2026-11-01"), { weeks: 2 }, 2)).toBe(
      IsoDate.make("2026-11-29"),
    );

    expect(
      previewOccurrences({
        startOn: "2026-01-31",
        every: { months: 1 },
        endOn: "2026-03-15",
        count: 3,
      }),
    ).toEqual([IsoDate.make("2026-01-31"), IsoDate.make("2026-02-28")]);
    expect(buildScheduleEvery("months", "3")).toEqual({ months: 3 });
    expect(buildScheduleEvery("weeks", "0")).toBeNull();
  });

  test("validates and builds TemplateInput", () => {
    const invalid = buildTemplateInput(emptyTemplateForm());
    expect(invalid.input).toBeNull();
    expect(invalid.errors["name"]).toBe("required");
    expect(invalid.errors["contact"]).toBe("required");

    const valid = buildTemplateInput({
      ...emptyTemplateForm(),
      name: "Hosting",
      contact: CONTACT_1,
      lines: [
        {
          id: "l1",
          description: "VPS",
          quantity: "2",
          unit: "ks",
          unitPrice: "500",
          vat: "standard",
        },
      ],
    });
    expect(valid.input).not.toBeNull();
    expect(valid.input?.name).toBe("Hosting");
    expect(valid.input?.lines).toHaveLength(1);
  });
});

describe("templates screens and API integration", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        const path = Str.replace(TRAILING_SLASH_RE, "")(url.pathname);
        if (Str.endsWith("/templates")(path) && req.method === "GET") {
          return Response.json([activeTemplateWire, pausedTemplateWire]);
        }
        if (Str.endsWith(`/templates/${TPL_2}`)(path) && req.method === "GET") {
          return Response.json(pausedTemplateWire);
        }
        if (Str.endsWith(`/templates/${TPL_2}/schedule`)(path) && req.method === "PUT") {
          return Response.json({ ...pausedTemplateWire, revision: 3 });
        }
        if (Str.endsWith(`/templates/${TPL_2}/resume`)(path) && req.method === "POST") {
          return Response.json({
            ...pausedTemplateWire,
            revision: 4,
            schedule: { ...pausedTemplateWire.schedule, paused: false, pausedReason: null },
          });
        }
        if (Str.endsWith(`/templates/${TPL_2}/runs`)(path) && req.method === "GET") {
          return Response.json({
            items: [
              {
                occurrence: "2026-11-01",
                outcome: "issued",
                at: "2026-11-01T08:00:00Z",
                document: { id: DOC_1, number: "2026-0042" },
                delivery: null,
                failure: null,
              },
              {
                occurrence: "2026-10-01",
                outcome: "failed",
                at: "2026-10-01T08:00:00Z",
                document: null,
                delivery: null,
                failure: "fx.rate_missing",
              },
            ],
            nextCursor: null,
          });
        }
        if (Str.endsWith("/contacts")(path) && req.method === "GET") {
          return Response.json({
            items: [{ id: CONTACT_1, name: "Client A" }],
            nextCursor: null,
          });
        }
        return Response.json({ _tag: "NotFound", entity: "Template" }, { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const within = (node: ReactElement) => (
    <TestProviders overlay={recordedOverlay()}>
      <ApiProvider token="tok" origin={server.url.origin}>
        <SessionProvider origin={server.url.origin}>
          <WorkspaceProvider
            workspace={WORKSPACE}
            workspaces={[WORKSPACE]}
            reload={() => undefined}
          >
            {node}
          </WorkspaceProvider>
        </SessionProvider>
      </ApiProvider>
    </TestProviders>
  );

  test("screens render expected controls via hostTree", () => {
    const listText = allText(hostTree(<TemplatesListScreen />, within));
    expect(listText).toContain("Invoice templates");
    expect(listText).toContain("Active");
    expect(listText).toContain("Paused after failure");

    const newTemplateId = "new";
    const newText = allText(
      hostTree(<TemplateDetailScreen id={newTemplateId} initialTab="template" />, within),
    );
    expect(newText).toContain("New template");
    expect(newText).toContain("Template name");
    expect(newText).toContain("Due in (days)");
  });

  test("end-to-end API runtime lists templates, updates schedule, resumes, and reads runs", async () => {
    const observed = { api: Option.none<ApiRunner>() };
    let count = 0;

    await root.render(
      within(
        <TemplatesProbe
          workspaceId={WS_ID}
          onReady={(a, n) => {
            observed.api = Option.some(a);
            count = n;
          }}
        />,
      ),
    );
    await Effect.runPromise(
      eventually(
        () => count === 2 && Option.isSome(observed.api),
        () => `count=${count} html=${root.container().innerHTML}`,
      ),
    );
    expect(count).toBe(2);

    const api = Option.getOrNull(observed.api);
    if (api === null) throw new Error("Templates API provider did not mount");

    // Set schedule with If-Match
    const scheduled = await api.run((c) =>
      c.templates.setSchedule({
        params: { workspaceId: WS_ID, templateId: TPL_2 },
        headers: ifMatchHeaders(2),
        payload: {
          every: { months: 3 },
          startOn: IsoDate.make("2026-11-01"),
          issueAs: "invoice",
          autoSend: true,
        },
      }),
    );
    expect(scheduled._tag).toBe("Ok");

    // Resume paused schedule
    const resumed = await api.run((c) =>
      c.templates.resume({ params: { workspaceId: WS_ID, templateId: TPL_2 } }),
    );
    if (resumed._tag !== "Ok") throw new Error("Expected schedule resume to succeed");
    expect(decodeTemplate(resumed.value)?.schedule?.paused).toBe(false);

    // Read run history
    const runs = await api.run((c) =>
      c.templates.runs({ params: { workspaceId: WS_ID, templateId: TPL_2 }, query: {} }),
    );
    if (runs._tag !== "Ok") throw new Error("Expected recurring run history");
    expect(runs.value.items).toHaveLength(2);
    expect(runs.value.items[0]?.document?.number).toBe("2026-0042");
    expect(String(runs.value.items[1]?.failure)).toBe("fx.rate_missing");

    const key = await Effect.runPromise(uuidV7);
    expect(idempotencyHeaders(key)["idempotency-key"]).toBe(key);
  });
});
