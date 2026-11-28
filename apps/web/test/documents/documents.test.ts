import { describe, expect, test } from "bun:test";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Documents from "../../src/page/documents/documents";
import { DocumentSummaryData } from "../../src/page/documents/shared";
import { ctxFor, renderPath, WS } from "../support";

const items = Effect.runSync(
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
      total: { amount: BigDecimal.fromBigInt(87120n), currency: "CZK" },
    },
  ]),
);

describe("Documents list page (Screen 09)", () => {
  const route: Documents.Route = { _tag: "Documents", ws: WS, query: {} };

  test("init starts loading and computes localized titles", () => {
    const ctxCs = ctxFor({ route, locale: "cs" });
    const ctxEn = ctxFor({ route, locale: "en" });
    const res = Documents.init(route, ctxCs);
    expect(res.model.list._tag).toBe("Loading");
    expect(res.commands?.length).toBe(1);
    expect(Documents.title(res.model, ctxCs)).toBe("Doklady");
    expect(Documents.title(res.model, ctxEn)).toBe("Documents");
  });

  test("stale-seq safety and cursor pagination append", () => {
    const ctx = ctxFor({ route });
    const { model } = Documents.init(route, ctx);
    const stale = Documents.update(
      model,
      Documents.Message.Loaded({
        seq: 42,
        data: { items, nextCursor: "c1" },
        append: false,
      }),
      ctx,
    );
    expect(stale.model.list._tag).toBe("Loading");

    const loaded = Documents.update(
      stale.model,
      Documents.Message.Loaded({
        seq: 1,
        data: { items, nextCursor: "c1" },
        append: false,
      }),
      ctx,
    );
    expect(loaded.model.list._tag).toBe("Loaded");

    const more = Documents.update(loaded.model, Documents.Message.ClickedLoadMore(), ctx);
    expect(more.model.loadingMore).toBe(true);
    expect(more.commands?.length).toBe(1);

    const appended = Documents.update(
      more.model,
      Documents.Message.Loaded({
        seq: 2,
        data: { items, nextCursor: null },
        append: true,
      }),
      ctx,
    );
    expect(appended.model.list._tag).toBe("Loaded");
    if (appended.model.list._tag !== "Loaded")
      throw new Error("Expected an appended document list");
    expect(appended.model.list.data.items.length).toBe(2);
    expect(appended.model.list.data.nextCursor).toBeNull();
  });

  test("filters emit navigation intents with updated query string", () => {
    const ctx = ctxFor({ route });
    const { model } = Documents.init(route, ctx);
    const typed = Documents.update(model, Documents.Message.ChangedSearch({ value: "Alza" }), ctx);
    const submitted = Documents.update(typed.model, Documents.Message.SubmittedSearch(), ctx);
    expect(submitted.outMessage?._tag).toBe("Navigate");
    if (submitted.outMessage?._tag !== "Navigate") throw new Error("Expected search navigation");
    expect(submitted.outMessage.path).toContain("text=Alza");

    const overdue = Documents.update(
      model,
      Documents.Message.ToggledOverdue({ checked: true }),
      ctx,
    );
    expect(overdue.outMessage?._tag).toBe("Navigate");
    if (overdue.outMessage?._tag !== "Navigate") throw new Error("Expected overdue navigation");
    expect(overdue.outMessage.path).toContain("overdue=true");
  });

  test("renders cs and en via SSR with zero-CLS skeleton table", async () => {
    const cs = await renderPath(`/w/${WS}/documents`, { locale: "cs" });
    expect(cs.html).toContain("Doklady");
    expect(cs.html).toContain("kb-skeleton");
    const en = await renderPath(`/w/${WS}/documents`, { locale: "en" });
    expect(en.html).toContain("Documents");
    expect(en.html).toContain("New invoice");
  });
});
