import { describe, expect, test } from "bun:test";
import { Html, HtmlServer } from "@effect/ui/html";
import { type DocumentView, LineView, StatutoryNote } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { RunApi } from "../../src/app/commands";
import * as Editor from "../../src/page/documents/editor";
import { ContactOptionData } from "../../src/page/documents/shared";
import { ctxFor, renderPath, WS } from "../support";
import {
  commandEffect,
  DOC_ID,
  jsonDocument,
  runCommand,
  sampleProforma,
  sessionWithRole,
} from "./fixtures";

const sampleContact = Schema.decodeUnknownSync(ContactOptionData)({
  id: "0193a000-0000-7000-8000-000000000201",
  roles: ["customer"],
  name: "Alza.cz a.s.",
  ico: "27082440",
  dic: "CZ27082440",
  legalForm: "a.s.",
  address: { street: "Jankovcova 53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
  billingEmails: ["fakturace@alza.example.cz"],
  phone: null,
  note: null,
  defaults: { dueDays: 21, currency: "EUR", language: "en", paymentMethod: "bank_transfer" },
  archived: false,
  revision: 1,
});

const newInvoiceRoute: Editor.Route = { _tag: "DocumentNew", ws: WS, kind: "invoice" };
const editRoute: Editor.Route = { _tag: "DocumentEdit", ws: WS, id: DOC_ID };
const draft: DocumentView = {
  ...sampleProforma,
  kind: "invoice",
  number: null,
  status: "draft",
  lines: [
    Schema.decodeUnknownSync(LineView)({
      id: "0193a000-0000-7000-8000-000000000651",
      item: null,
      description: "Saved line",
      quantity: "1",
      unit: "ks",
      unitPrice: "12000",
      treatment: "standard",
      ratePercent: "21",
      amount: "12000",
      deducts: null,
    }),
  ],
};

const preparedEditor = (
  doc: DocumentView | null,
  ctx = ctxFor(doc === null ? newInvoiceRoute : editRoute),
) => {
  const route = doc === null ? newInvoiceRoute : editRoute;
  const update = (model: Editor.Model, message: Editor.Message) =>
    Editor.update(model, message, ctx);
  const initial = Editor.init(route, ctx).model;
  const loaded = update(
    initial,
    Editor.Message.LoadedLookups({
      seq: 1,
      data: {
        workspace: null,
        contacts: [sampleContact],
        priceList: [],
        series: [],
        bankAccounts: [],
        templates: [],
        existingDoc: doc,
      },
    }),
  );
  const model =
    doc === null
      ? update(loaded.model, Editor.Message.SelectedContact({ contactId: sampleContact.id })).model
      : loaded.model;
  const describeLine = (model: Editor.Model, value: string) =>
    update(
      model,
      Editor.Message.UpdatedLineField({
        key: model.lines[0]?.key ?? "l1",
        field: "description",
        value,
      }),
    );
  return { update, model, describeLine, ctx };
};

const renderEditor = (model: Editor.Model, ctx: ReturnType<typeof ctxFor>) => {
  const component = Html.component({
    name: "EditorTest",
    model: Editor.Model,
    message: Editor.Message,
  }).make({
    init: () => model,
    update: ($) => $.model,
    view: (h, model) => Editor.view(model, ctx, h),
  });
  return Effect.runPromise(HtmlServer.renderToHtml(component, {}));
};

describe("DocumentEditor page (Screen 10)", () => {
  test("init loads lookups and starts with one line", () => {
    const ctxCs = ctxFor(newInvoiceRoute, { locale: "cs" });
    const ctxEn = ctxFor(newInvoiceRoute, { locale: "en" });
    const res = Editor.init(newInvoiceRoute, ctxCs);
    expect(res.model.lookups._tag).toBe("Loading");
    expect(res.model.lines.length).toBe(1);
    expect(Editor.title(res.model, ctxCs)).toBe("Nová faktura");
    expect(Editor.title(res.model, ctxEn)).toBe("New invoice");
  });

  test("line items add, update, move, and remove cleanly", () => {
    const ctx = ctxFor(newInvoiceRoute);
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const s1 = Editor.update(
      model,
      Editor.Message.UpdatedLineField({ key: "l1", field: "description", value: "First" }),
      ctx,
    );
    const s2 = Editor.update(s1.model, Editor.Message.AddedLine(), ctx);
    expect(s2.model.lines.length).toBe(2);
    const s3 = Editor.update(
      s2.model,
      Editor.Message.UpdatedLineField({ key: "l2", field: "description", value: "Second" }),
      ctx,
    );
    const moved = Editor.update(
      s3.model,
      Editor.Message.MovedLine({ key: "l2", direction: "up" }),
      ctx,
    );
    expect(moved.model.lines[0]?.description).toBe("Second");
    expect(moved.model.lines[1]?.description).toBe("First");

    const removed = Editor.update(moved.model, Editor.Message.RemovedLine({ key: "l2" }), ctx);
    expect(removed.model.lines.length).toBe(1);
    expect(removed.model.lines[0]?.key).toBe("l1");
  });

  test("ARES quick-add selects returned contact and stale lookup seq is dropped", () => {
    const ctx = ctxFor(newInvoiceRoute);
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const stale = Editor.update(
      model,
      Editor.Message.LoadedLookups({
        seq: 999,
        data: {
          workspace: null,
          contacts: [sampleContact],
          priceList: [],
          series: [],
          bankAccounts: [],
          templates: [],
          existingDoc: null,
        },
      }),
      ctx,
    );
    expect(stale.model.lookups._tag).toBe("Loading");

    const loaded = Editor.update(
      stale.model,
      Editor.Message.LoadedLookups({
        seq: 1,
        data: {
          workspace: null,
          contacts: [],
          priceList: [],
          series: [],
          bankAccounts: [],
          templates: [],
          existingDoc: null,
        },
      }),
      ctx,
    );
    const toggled = Editor.update(loaded.model, Editor.Message.ToggledAres(), ctx);
    expect(toggled.model.aresOpen).toBe(true);
    const added = Editor.update(
      toggled.model,
      Editor.Message.AresSucceeded({ contact: sampleContact }),
      ctx,
    );
    expect(added.model.contactId).toBe(sampleContact.id);
    expect(added.model.aresOpen).toBe(false);
    expect(added.outMessage?._tag).toBe("Toast");
  });

  test("validation rejects missing contact before submitting", () => {
    const ctx = ctxFor(newInvoiceRoute, { locale: "en" });
    const { model } = Editor.init(newInvoiceRoute, ctx);
    const res = Editor.update(model, Editor.Message.ClickedSaveDraft(), ctx);
    expect(res.model.submitError).toContain("customer");
    expect(res.commands).toBeUndefined();
  });

  test("VAT/FX calculation engine matches standard 21% and EUR->CZK conversion", () => {
    const calc = ViewModels.calculate({
      lines: [
        {
          quantity: BigDecimal.fromBigInt(2n),
          unitPrice: BigDecimal.fromBigInt(1000n),
          treatment: "standard",
        },
      ],
      currency: "EUR" as never,
      taxPoint: "2026-11-24" as never,
      pricesIncludeVat: false,
      fx: { rate: BigDecimal.fromBigInt(25n), quantity: 1 },
      paymentRounding: "none",
      direction: "outgoing",
      taxRegime: "vat_payer",
      kind: "invoice",
    });
    expect(Result.isSuccess(calc)).toBe(true);
    if (Result.isSuccess(calc)) {
      expect(BigDecimal.format(calc.success.breakdown.net.amount)).toBe("2000");
      expect(BigDecimal.format(calc.success.breakdown.vat.amount)).toBe("420");
      expect(BigDecimal.format(calc.success.breakdown.gross.amount)).toBe("2420");
      expect(calc.success.breakdown.vatCzk).not.toBeNull();
      if (calc.success.breakdown.vatCzk !== null) {
        expect(BigDecimal.format(calc.success.breakdown.vatCzk.amount)).toBe("10500");
      }
    }
  });

  test("issues edited draft content at the revision returned by PATCH and replays only issue after a lost reply", async () => {
    const { update, model, describeLine } = preparedEditor(draft);
    expect(model.lines[0]?.description).toBe("Saved line");
    expect(model.lines[0]?.unitPrice).toBe("12000");
    const edited = describeLine(model, "Change before Issue");
    const requests: Array<{
      path: string;
      method: string;
      revision: string | null;
      key: string | null;
      body: unknown;
    }> = [];
    let issues = 0;
    const fetch = async (request: Request) => {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        revision: request.headers.get("if-match"),
        key: request.headers.get("idempotency-key"),
        body: await request.json(),
      });
      if (request.method === "PATCH") return jsonDocument({ ...draft, revision: 11 });
      if (++issues === 1) throw new TypeError("lost issue reply");
      return jsonDocument({ ...draft, revision: 12, status: "issued" });
    };

    const save = update(edited.model, Editor.Message.ClickedIssue());
    expect(
      update(save.model, Editor.Message.AutosaveDue({ seq: save.model.previewSeq })).commands,
    ).toBeUndefined();
    const mint = update(save.model, await runCommand(save.commands, fetch));
    const issue = update(mint.model, await runCommand(mint.commands));
    const failed = update(issue.model, await runCommand(issue.commands, fetch));
    const retry = update(failed.model, Editor.Message.ClickedIssue());
    const done = update(retry.model, await runCommand(retry.commands, fetch));

    expect(requests.map(({ method, revision }) => [method, revision])).toEqual([
      ["PATCH", '"3"'],
      ["POST", '"11"'],
      ["POST", '"11"'],
    ]);
    expect(requests[0]?.body).toEqual({
      lines: [
        {
          description: "Change before Issue",
          quantity: "1",
          unit: "ks",
          unitPrice: "12000",
          vat: "standard",
        },
      ],
    });
    expect(requests[1]?.path).toEndWith(`/${DOC_ID}/issue`);
    expect(requests[1]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[2]).toEqual(requests[1]);
    expect(done.model.savedDoc?.status).toBe("issued");
    expect(done.outMessage?._tag).toBe("Navigate");
  });

  test("issuing a new invoice retries its original key and starts no draft or replacement issue", async () => {
    const { model, update, describeLine } = preparedEditor(null);
    const edited = describeLine(model, "New invoice line");
    const mint = update(edited.model, Editor.Message.ClickedIssue());
    const issue = update(mint.model, await runCommand(mint.commands));
    const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
    const fetch = async (request: Request) => {
      requests.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("idempotency-key"),
        body: await request.json(),
      });
      if (requests.length === 1) throw new TypeError("lost reply");
      return jsonDocument({ ...draft, status: "issued", revision: 7 }, 201);
    };
    const failed = update(issue.model, await runCommand(issue.commands, fetch));
    expect(update(failed.model, Editor.Message.ClickedSaveDraft()).commands).toBeUndefined();
    const retry = update(failed.model, Editor.Message.ClickedIssue());
    const done = update(retry.model, await runCommand(retry.commands, fetch));
    expect(requests[0]?.path).toEndWith("/documents/issue");
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[0]?.body).toMatchObject({
      input: { lines: [{ description: "New invoice line" }] },
    });
    expect(requests[1]).toEqual(requests[0]);
    expect(done.outMessage?._tag).toBe("Navigate");
  });

  test("debounces preview at 400 ms and autosave at 3 s and ignores answers to older edits", async () => {
    const { update, describeLine, model, ctx } = preparedEditor(null);
    const first = describeLine(model, "Earlier");
    const edited = describeLine(first.model, "Latest");
    const [previewTimer, autosaveTimer] = edited.commands ?? [];
    if (previewTimer === undefined || autosaveTimer === undefined)
      throw new Error("Missing editor timers");
    const [previewDue, saveDue] = await Effect.runPromise(
      Effect.gen(function* () {
        const previewFiber = yield* Effect.forkChild(commandEffect([previewTimer]));
        const saveFiber = yield* Effect.forkChild(commandEffect([autosaveTimer]));
        yield* TestClock.adjust(399);
        expect(previewFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const preview = yield* Fiber.join(previewFiber);
        yield* TestClock.adjust(2599);
        expect(saveFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        return [preview, yield* Fiber.join(saveFiber)] as const;
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(RunApi.layer)),
    );
    expect(
      update(edited.model, Editor.Message.DebouncedPreview({ seq: first.model.previewSeq }))
        .commands,
    ).toBeUndefined();
    const preview = update(edited.model, previewDue);
    expect(
      update(preview.model, Editor.Message.DebouncedPreview({ seq: edited.model.previewSeq }))
        .commands,
    ).toBeUndefined();
    const canonical = {
      ...draft,
      statutoryNotes: [
        Schema.decodeUnknownSync(StatutoryNote)({ code: "test", text: "Authoritative tax note" }),
      ],
      paymentQr: { format: "spayd" as const, payload: "SPD*1.0*AM:14520*CC:CZK" },
    };
    const reply = await runCommand(preview.commands, async (request) => {
      expect(new URL(request.url).pathname).toEndWith("/documents/preview");
      expect(await request.json()).toMatchObject({ lines: [{ description: "Latest" }] });
      return jsonDocument(canonical);
    });
    const newer = describeLine(preview.model, "Newer");
    expect(update(newer.model, reply).model.serverPreview._tag).toBe("Idle");
    const settled = update(preview.model, reply);
    expect(settled.model.calcDrift).toBe(true);
    const rendered = await renderEditor(settled.model, ctx);
    expect(rendered.html).toContain("Authoritative tax note");
    expect(rendered.html).toContain('alt="Platební QR kód"');
    expect(update(settled.model, saveDue).model.draftWrite?.intent).toBe("autosave");
  });

  test("serializes autosave creation and newer edits, and replays the exact attempt after a lost reply", async () => {
    const { update, model, describeLine } = preparedEditor(null);
    const first = describeLine(model, "First version");
    const mint = update(first.model, Editor.Message.AutosaveDue({ seq: first.model.previewSeq }));
    const create = update(mint.model, await runCommand(mint.commands));
    const second = describeLine(create.model, "Second version");
    const ready = update(
      second.model,
      Editor.Message.AutosaveDue({ seq: second.model.previewSeq }),
    );
    expect(ready.commands).toBeUndefined();
    expect(update(ready.model, Editor.Message.ClickedIssue()).commands).toBeUndefined();

    const requests: Array<{
      method: string;
      key: string | null;
      revision: string | null;
      body: unknown;
    }> = [];
    const fetch = async (request: Request) => {
      requests.push({
        method: request.method,
        key: request.headers.get("idempotency-key"),
        revision: request.headers.get("if-match"),
        body: await request.json(),
      });
      if (requests.length === 1) throw new TypeError("lost draft reply");
      if (request.method === "POST") return jsonDocument({ ...draft, revision: 19 }, 201);
      return jsonDocument({ ...draft, revision: 20 });
    };
    const failed = update(ready.model, await runCommand(create.commands, fetch));
    const retry = update(failed.model, Editor.Message.ClickedRetryAutosave());
    const patch = update(retry.model, await runCommand(retry.commands, fetch));
    const saved = update(patch.model, await runCommand(patch.commands, fetch));

    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[0]?.body).toMatchObject({ lines: [{ description: "First version" }] });
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toMatchObject({
      method: "PATCH",
      revision: '"19"',
      body: { lines: [{ description: "Second version" }] },
    });
    expect(saved.model.savedDoc?.revision).toBe(20);
    expect(saved.model.dirty).toBe(false);
    expect(saved.outMessage).toBeUndefined();
  });

  test("a stale draft stops issuance and autosave, and reload keeps local edits for review", async () => {
    const { update, describeLine, model } = preparedEditor(draft);
    const edited = describeLine(model, "Keep this local");
    const save = update(edited.model, Editor.Message.ClickedIssue());
    const conflict = update(
      save.model,
      await runCommand(save.commands, () =>
        Response.json({ _tag: "PreconditionFailed", currentRevision: 23 }, { status: 412 }),
      ),
    );
    expect(conflict.model.revisionState).toBe("stale");
    expect(conflict.commands).toBeUndefined();
    expect(update(conflict.model, Editor.Message.ClickedIssue()).commands).toBeUndefined();

    const reload = update(conflict.model, Editor.Message.ClickedReloadRevision());
    const reviewed = update(
      reload.model,
      await runCommand(reload.commands, (request) => {
        expect(request.method).toBe("GET");
        return jsonDocument({ ...draft, revision: 23, paymentMethod: "cash" });
      }),
    );
    expect(reviewed.model.savedDoc?.revision).toBe(23);
    expect(reviewed.model.revisionState).toBe("review");
    expect(reviewed.model.revisionChanges).toContain("Způsob úhrady");
    expect(reviewed.model.lines[0]?.description).toBe("Keep this local");
    expect(
      update(reviewed.model, Editor.Message.AutosaveDue({ seq: reviewed.model.previewSeq }))
        .commands,
    ).toBeUndefined();
  });

  test("issued documents never autosave and accountants cannot write from a direct editor route", async () => {
    const issued = { ...draft, status: "issued", number: "2026-0023" } as const;
    const { model, update, describeLine } = preparedEditor(issued);
    const edited = describeLine(model, "Explicit save only");
    expect(edited.commands?.length).toBe(1);
    expect(
      update(edited.model, Editor.Message.AutosaveDue({ seq: edited.model.previewSeq })).commands,
    ).toBeUndefined();

    const explicitSave = update(edited.model, Editor.Message.ClickedSaveIssued());
    const requests: Array<{ method: string; revision: string | null; body: unknown }> = [];
    const saved = update(
      explicitSave.model,
      await runCommand(explicitSave.commands, async (request) => {
        requests.push({
          method: request.method,
          revision: request.headers.get("if-match"),
          body: await request.json(),
        });
        return jsonDocument({ ...issued, revision: 4 });
      }),
    );
    expect(requests).toEqual([
      {
        method: "PATCH",
        revision: '"3"',
        body: {
          lines: [
            {
              description: "Explicit save only",
              quantity: "1",
              unit: "ks",
              unitPrice: "12000",
              vat: "standard",
            },
          ],
        },
      },
    ]);
    expect(saved.outMessage?._tag).toBe("Navigate");

    const readOnly = preparedEditor(
      draft,
      ctxFor(editRoute, { locale: "en", session: sessionWithRole("accountant") }),
    );
    const rendered = await renderEditor(readOnly.model, readOnly.ctx);
    expect(rendered.html).toContain("This document cannot be edited here.");
    expect(rendered.html).not.toContain("Issue document");
    expect(
      readOnly.update(readOnly.model, Editor.Message.ClickedSaveDraft()).commands,
    ).toBeUndefined();
    expect(readOnly.update(readOnly.model, Editor.Message.ClickedIssue()).commands).toBeUndefined();
  });

  test("renders cs and en via SSR with plain copy (no Live or Živá qualifiers)", async () => {
    const cs = await renderPath(`/w/${WS}/documents/new/invoice`, { locale: "cs" });
    expect(cs.html).toContain("Náhled faktury");
    expect(cs.html).toContain("Rekapitulace DPH");
    expect(cs.html).not.toContain("Živá");
    const en = await renderPath(`/w/${WS}/documents/new/invoice`, { locale: "en" });
    expect(en.html).toContain("Invoice preview");
    expect(en.html).toContain("VAT summary");
    expect(en.html).not.toContain("Live ");
  });
});
