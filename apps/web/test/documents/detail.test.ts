import { describe, expect, test } from "bun:test";
import { Html, HtmlServer } from "@effect/ui/html";
import type { DocumentView } from "@kvitbit/domain";
import { Effect } from "effect";
import * as Detail from "../../src/page/documents/detail";
import { ctxFor, renderPath, WS } from "../support";
import { DOC_ID, runCommand, sampleProforma, sessionWithRole } from "./fixtures";

describe("DocumentDetail page (Screen 11)", () => {
  const route: Detail.Route = { _tag: "Document", ws: WS, id: DOC_ID, tab: "preview" };

  const loadedDetail = (doc: DocumentView, ctx = ctxFor(route, { locale: "en" })) => {
    const update = (model: Detail.Model, message: Detail.Message) =>
      Detail.update(model, message, ctx);
    const initial = Detail.init(route, ctx).model;
    const { model } = update(
      initial,
      Detail.Message.LoadedDetail({
        seq: 1,
        data: { doc, payments: [], history: [], shareViews: [] },
      }),
    );
    return { model, update, ctx };
  };

  const renderDetail = (model: Detail.Model, ctx: ReturnType<typeof ctxFor>) => {
    const component = Html.component({
      name: "DetailTest",
      model: Detail.Model,
      message: Detail.Message,
    }).make({
      init: () => model,
      update: ($) => $.model,
      view: (h, model) => Detail.view(model, ctx, h),
    });
    return Effect.runPromise(HtmlServer.renderToHtml(component, {}));
  };

  test("init loads detail and honors route dialog param", () => {
    const ctx = ctxFor(route, { locale: "cs" });
    const res = Detail.init(route, ctx);
    expect(res.model.detail._tag).toBe("Loading");
    expect(res.model.activeDialog).toBeNull();
    expect(res.commands?.length).toBe(1);

    const withDlg = Detail.init({ ...route, dialog: "payment" }, ctx);
    expect(withDlg.model.activeDialog).toBe("payment");
  });

  test("stale-seq safety and prefill of send/payment dialogs on load", () => {
    const ctx = ctxFor(route);
    const { model } = Detail.init(route, ctx);
    const stale = Detail.update(
      model,
      Detail.Message.LoadedDetail({
        seq: 7,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );
    expect(stale.model.detail._tag).toBe("Loading");

    const loaded = Detail.update(
      stale.model,
      Detail.Message.LoadedDetail({
        seq: 1,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );
    expect(loaded.model.detail._tag).toBe("Loaded");
    expect(loaded.model.sendTo).toBe("fakturace@alza.example.cz");
    expect(loaded.model.payAmount).toBe("14520");
    expect(Detail.title(loaded.model, ctx)).toBe("ZF-2026-0011");
  });

  test("a settled proforma can issue a Final Invoice and an invoice can issue a Credit Note", () => {
    const ctx = ctxFor(route, { locale: "en" });
    const { model } = Detail.init(route, ctx);
    const loaded = Detail.update(
      model,
      Detail.Message.LoadedDetail({
        seq: 1,
        data: { doc: sampleProforma, payments: [], history: [], shareViews: [] },
      }),
      ctx,
    );

    const openFinal = Detail.update(
      loaded.model,
      Detail.Message.OpenedDialog({ dialog: "final" }),
      ctx,
    );
    expect(openFinal.model.activeDialog).toBe("final");
    const submitFinal = Detail.update(openFinal.model, Detail.Message.SubmittedFinalInvoice(), ctx);
    expect(submitFinal.model.busy).toBe(true);
    expect(submitFinal.commands?.length).toBe(1);

    expect(
      Detail.update(loaded.model, Detail.Message.OpenedDialog({ dialog: "correct" }), ctx).model
        .activeDialog,
    ).toBeNull();

    const invoice = loadedDetail({ ...sampleProforma, kind: "invoice" }, ctx);
    const openCredit = Detail.update(
      invoice.model,
      Detail.Message.OpenedDialog({ dialog: "correct" }),
      ctx,
    );
    const typedReason = Detail.update(
      openCredit.model,
      Detail.Message.ChangedReason({ value: "Price discount" }),
      ctx,
    );
    const submitCredit = Detail.update(
      typedReason.model,
      Detail.Message.SubmittedCreditNote(),
      ctx,
    );
    expect(submitCredit.model.busy).toBe(true);
    expect(submitCredit.commands?.length).toBe(1);

    const copyShare = Detail.update(
      loaded.model,
      Detail.Message.ClickedCopyShare({ url: "https://app.kvitbit.cz/i/abc" }),
      ctx,
    );
    expect(copyShare.commands?.length).toBe(1);
    const copied = Detail.update(copyShare.model, Detail.Message.CopiedShare({ ok: true }), ctx);
    expect(copied.outMessage?._tag).toBe("Toast");
  });

  test("reopening a payment after a lost response replays the same request and closes on success", async () => {
    const { model, update } = loadedDetail(sampleProforma);
    const opened = update(model, Detail.Message.OpenedDialog({ dialog: "payment" }));
    const typed = update(opened.model, Detail.Message.ChangedPayAmount({ value: "300" }));
    const mint = update(typed.model, Detail.Message.SubmittedPayment());
    const payment = update(mint.model, await runCommand(mint.commands));
    const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
    const fetch = async (request: Request) => {
      requests.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("idempotency-key"),
        body: await request.json(),
      });
      if (requests.length === 1) throw new TypeError("lost payment reply");
      return Response.json({ payment: {}, settlement: "paid", issued: [] }, { status: 201 });
    };
    const failed = update(payment.model, await runCommand(payment.commands, fetch));
    expect(failed.model.dialogError).not.toBeNull();
    const close = update(failed.model, Detail.Message.ClosedDialog());
    const reopen = update(close.model, Detail.Message.OpenedDialog({ dialog: "payment" }));
    const changed = update(reopen.model, Detail.Message.ChangedPayAmount({ value: "400" }));
    const retry = update(changed.model, Detail.Message.SubmittedPayment());
    const done = update(retry.model, await runCommand(retry.commands, fetch));

    expect(requests[0]?.path).toEndWith("/payments");
    expect(requests[0]?.body).toMatchObject({
      target: { document: DOC_ID },
      amount: { amount: "300" },
    });
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]).toEqual(requests[0]);
    expect(done.model.pendingRequestKey).toBeNull();
    expect(done.model.activeDialog).toBeNull();
    expect(done.outMessage?._tag).toBe("Toast");
  });

  test("detail renders role and lifecycle permissions and enforces them in update", async () => {
    const accountant = loadedDetail(
      sampleProforma,
      ctxFor(route, { locale: "en", session: sessionWithRole("accountant") }),
    );
    const accountantHtml = (await renderDetail(accountant.model, accountant.ctx)).html;
    expect(accountantHtml).toContain("Download PDF");
    expect(accountantHtml).not.toContain("Record payment");
    expect(accountantHtml).not.toContain("Issue final invoice");
    expect(accountantHtml).not.toContain("/edit");
    expect(
      accountant.update(accountant.model, Detail.Message.OpenedDialog({ dialog: "payment" })).model
        .activeDialog,
    ).toBeNull();
    expect(
      accountant.update(
        { ...accountant.model, activeDialog: "payment" },
        Detail.Message.SubmittedPayment(),
      ).commands,
    ).toBeUndefined();
    const draftAccountant = loadedDetail({ ...sampleProforma, status: "draft" }, accountant.ctx);
    expect((await renderDetail(draftAccountant.model, accountant.ctx)).html).not.toContain(
      ">Issue<",
    );
    expect(
      draftAccountant.update(
        { ...draftAccountant.model, activeDialog: "issue" },
        Detail.Message.SubmittedIssueDraft(),
      ).commands,
    ).toBeUndefined();

    const locked = { ...sampleProforma, locked: true };
    const member = loadedDetail(
      locked,
      ctxFor(route, { locale: "en", session: sessionWithRole("member") }),
    );
    const admin = loadedDetail(
      locked,
      ctxFor(route, { locale: "en", session: sessionWithRole("admin") }),
    );
    expect((await renderDetail(member.model, member.ctx)).html).not.toContain(">Unlock<");
    expect((await renderDetail(admin.model, admin.ctx)).html).toContain(">Unlock<");
    const unlock = {
      ...member.model,
      activeDialog: "unlock" as const,
      reasonText: "Correct a line",
    };
    expect(member.update(unlock, Detail.Message.SubmittedUnlock()).commands).toBeUndefined();
    expect(admin.update(unlock, Detail.Message.SubmittedUnlock()).commands?.length).toBe(1);
  });

  test("renders cs and en via SSR", async () => {
    const cs = await renderPath(`/w/${WS}/documents/${DOC_ID}`, { locale: "cs" });
    expect(cs.html).toContain("Doklad");
    const en = await renderPath(`/w/${WS}/documents/${DOC_ID}`, { locale: "en" });
    expect(en.html).toContain("Document");
  });
});
