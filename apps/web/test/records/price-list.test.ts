import { describe, expect, test } from "bun:test";
import * as PriceList from "../../src/page/records/price-list";
import type { PriceListItemRecord } from "../../src/page/records/shared";
import { ctxFor, renderPath, WS } from "../support";

const SAMPLE_ITEM: PriceListItemRecord = {
  id: "0193a000-0000-7000-8000-000000000301",
  name: "UX & produktový design",
  description: "Návrh rozhraní",
  unit: "hod",
  unitPrice: "1850.00",
  currency: "CZK",
  vat: "standard",
  archived: false,
  revision: 1,
};

describe("PriceList page TEA", () => {
  test("init loads items, shows shimmer skeleton while loading, and enforces stale-seq safety", () => {
    const route: PriceList.Route = { _tag: "PriceList", ws: WS };
    const ctxCs = ctxFor(route, { locale: "cs" });
    const ctxEn = ctxFor(route, { locale: "en" });
    let { model, commands } = PriceList.init(route, ctxCs);
    expect(model.items._tag).toBe("Loading");
    expect(commands?.length).toBe(1);
    expect(PriceList.title(model, ctxCs)).toBe("Ceník");
    expect(PriceList.title(model, ctxEn)).toBe("Price list");

    // Toggle archived bumps seq to 2
    model = PriceList.update(
      model,
      PriceList.Message.ToggledIncludeArchived({ checked: true }),
      ctxCs,
    ).model;

    // Late seq 1 response ignored
    model = PriceList.update(
      model,
      PriceList.Message.LoadedItems({ seq: 1, items: [] }),
      ctxCs,
    ).model;
    expect(model.items._tag).toBe("Loading");

    // Current seq 2 response applied
    model = PriceList.update(
      model,
      PriceList.Message.LoadedItems({ seq: 2, items: [SAMPLE_ITEM] }),
      ctxCs,
    ).model;
    expect(model.items._tag).toBe("Loaded");
    if (model.items._tag !== "Loaded") throw new Error("Expected Loaded");
    expect(model.items.data).toHaveLength(1);
  });

  test("create/edit validation and save flow updates list optimistically on success", () => {
    const route: PriceList.Route = { _tag: "PriceList", ws: WS };
    const ctx = ctxFor(route);
    let { model } = PriceList.init(route, ctx);
    model = PriceList.update(
      model,
      PriceList.Message.LoadedItems({ seq: 1, items: [] }),
      ctx,
    ).model;

    model = PriceList.update(model, PriceList.Message.ClickedNew(), ctx).model;
    expect(model.editor).not.toBeNull();

    // Empty name blocked
    const bad = PriceList.update(model, PriceList.Message.SubmittedEditor(), ctx);
    expect(bad.commands ?? []).toHaveLength(0);
    expect(bad.model.editor?.error).not.toBeNull();

    // Valid name + price submits command
    model = PriceList.update(
      model,
      PriceList.Message.ChangedField({ field: "name", value: "Design sprint" }),
      ctx,
    ).model;
    model = PriceList.update(
      model,
      PriceList.Message.ChangedField({ field: "unitPrice", value: "25000" }),
      ctx,
    ).model;
    const ok = PriceList.update(model, PriceList.Message.SubmittedEditor(), ctx);
    expect(ok.commands?.length).toBe(1);
    expect(ok.model.editor?.saving).toBe(true);

    const saved = PriceList.update(
      ok.model,
      PriceList.Message.SavedItem({ item: SAMPLE_ITEM }),
      ctx,
    );
    expect(saved.model.editor).toBeNull();
    expect(saved.outMessage?._tag).toBe("Toast");
    if (saved.model.items._tag !== "Loaded") throw new Error("Expected Loaded");
    expect(saved.model.items.data).toHaveLength(1);
  });

  test("archive flow removes item when includeArchived is false", () => {
    const route: PriceList.Route = { _tag: "PriceList", ws: WS };
    const ctx = ctxFor(route);
    let { model } = PriceList.init(route, ctx);
    model = PriceList.update(
      model,
      PriceList.Message.LoadedItems({ seq: 1, items: [SAMPLE_ITEM] }),
      ctx,
    ).model;
    model = PriceList.update(
      model,
      PriceList.Message.RequestedArchive({ item: SAMPLE_ITEM }),
      ctx,
    ).model;
    const confirmed = PriceList.update(model, PriceList.Message.ConfirmedArchive(), ctx);
    expect(confirmed.commands?.length).toBe(1);
    const archived = PriceList.update(
      confirmed.model,
      PriceList.Message.ArchivedItem({ id: SAMPLE_ITEM.id }),
      ctx,
    );
    expect(archived.model.confirmArchive).toBeNull();
    if (archived.model.items._tag !== "Loaded") throw new Error("Expected Loaded");
    expect(archived.model.items.data).toHaveLength(0);
  });

  test("SSR renders price list with zero-CLS shimmer skeleton in cs and en", async () => {
    const cs = await renderPath(`/w/${WS}/price-list`, { locale: "cs" });
    expect(cs.title).toContain("Ceník");
    expect(cs.html).toContain("kb-skeleton");

    const en = await renderPath(`/w/${WS}/price-list`, { locale: "en" });
    expect(en.title).toContain("Price list");
  });
});
