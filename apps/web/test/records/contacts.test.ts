import { describe, expect, test } from "bun:test";
import type { ContactId } from "@kvitbit/domain/contract";
import * as Contacts from "../../src/page/records/contacts";
import type { ContactRecord } from "../../src/page/records/shared";
import { ctxFor, renderPath, WS } from "../support";

const SAMPLE_CONTACT: ContactRecord = {
  id: "0193a000-0000-7000-8000-000000000201",
  roles: ["customer"],
  name: "Nordic Craft s.r.o.",
  ico: "04829132",
  dic: "CZ04829132",
  legalForm: "s.r.o.",
  address: { street: "Křižíkova 148", city: "Praha 8", postalCode: "186 00", country: "CZ" },
  billingEmails: ["fakturace@nordiccraft.cz"],
  phone: "+420 222 111 333",
  note: null,
  defaults: {
    currency: "EUR",
    language: "en",
    dueDays: 21,
    paymentMethod: "bank_transfer",
    reminderPolicy: { mode: "custom", offsetsDays: [7, 14] },
  },
  registryFetchedAt: "2026-11-10T09:15:00.000Z",
  archived: false,
  revision: 2,
};

describe("Contacts page TEA", () => {
  test("init loads contacts list and handles live search & role filters with stale-seq safety", () => {
    const route: Contacts.Route = { _tag: "Contacts", ws: WS, query: {} };
    const ctx = ctxFor(route, { locale: "cs" });
    let { model, commands } = Contacts.init(route, ctx);
    expect(model.list._tag).toBe("Loading");
    expect(commands?.length).toBe(1);
    expect(Contacts.title(model, ctx)).toBe("Kontakty");

    // Role filter bumps seq to 2
    const filtered = Contacts.update(
      model,
      Contacts.Message.SelectedRoleFilter({ role: "customer" }),
      ctx,
    );
    model = filtered.model;
    expect(filtered.commands?.length).toBe(1);

    // Stale seq 1 response dropped
    model = Contacts.update(
      model,
      Contacts.Message.LoadedList({ seq: 1, contacts: [] }),
      ctx,
    ).model;
    expect(model.list._tag).toBe("Loading");

    // Current seq 2 response applied
    model = Contacts.update(
      model,
      Contacts.Message.LoadedList({ seq: 2, contacts: [SAMPLE_CONTACT] }),
      ctx,
    ).model;
    expect(model.list._tag).toBe("Loaded");
    if (model.list._tag === "Loaded") {
      expect(model.list.data).toHaveLength(1);
      expect(model.list.data[0]?.name).toBe("Nordic Craft s.r.o.");
    }
  });

  test("ARES IČO lookup validates checksum and populates contact editor", () => {
    const route: Contacts.Route = { _tag: "Contact", ws: WS, id: "new", mode: "edit" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Contacts.init(route, ctx);

    // Invalid IČO rejected client-side
    model = Contacts.update(
      model,
      Contacts.Message.ChangedEditorField({ field: "icoLookup", value: "99999999" }),
      ctx,
    ).model;
    const bad = Contacts.update(model, Contacts.Message.ClickedLookupAres(), ctx);
    expect(bad.commands ?? []).toHaveLength(0);
    expect(bad.model.editor?.aresError).not.toBeNull();

    // Valid IČO (Alza 27082440) dispatches lookup
    model = Contacts.update(
      model,
      Contacts.Message.ChangedEditorField({ field: "icoLookup", value: "27082440" }),
      ctx,
    ).model;
    const ok = Contacts.update(model, Contacts.Message.ClickedLookupAres(), ctx);
    expect(ok.commands?.length).toBe(1);
    const seq = ok.model.editor?.aresSeq ?? 0;
    const filled = Contacts.update(
      ok.model,
      Contacts.Message.LoadedAresLookup({ seq, contact: SAMPLE_CONTACT }),
      ctx,
    );
    expect(filled.model.editor?.name).toBe("Nordic Craft s.r.o.");
    expect(filled.model.editor?.dic).toBe("CZ04829132");
  });

  test("editor override clear resets billing default back to workspace inheritance", () => {
    const route: Contacts.Route = {
      _tag: "Contact",
      ws: WS,
      id: SAMPLE_CONTACT.id as ContactId,
      mode: "edit",
    };
    const ctx = ctxFor(route);
    let { model } = Contacts.init(route, ctx);
    model = Contacts.update(
      model,
      Contacts.Message.LoadedDetail({ seq: 1, contact: SAMPLE_CONTACT }),
      ctx,
    ).model;
    expect(model.editor?.currencyOverride).toBe("EUR");
    model = Contacts.update(
      model,
      Contacts.Message.ClearedOverride({ field: "currencyOverride" }),
      ctx,
    ).model;
    expect(model.editor?.currencyOverride).toBe("");
  });

  test("SSR renders contacts list and new contact editor in cs and en", async () => {
    const csList = await renderPath(`/w/${WS}/contacts`, { locale: "cs" });
    expect(csList.title).toContain("Kontakty");
    expect(csList.html).toContain('data-slot="rec-toolbar"');

    const enNew = await renderPath(`/w/${WS}/contacts/new?mode=edit`, { locale: "en" });
    expect(enNew.title).toContain("New contact");
    expect(enNew.html).toContain("ARES");
  });
});
