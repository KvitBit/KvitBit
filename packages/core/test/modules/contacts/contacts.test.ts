import { describe, expect, test } from "bun:test";
import type {
  Caller,
  ContactId,
  ContactView,
  CurrencyCode,
  CurrentCaller,
  NumberingSeriesId,
  RequestKey,
} from "@kvitbit/domain/contract";
import { Contacts, Unavailable } from "@kvitbit/domain/contract";
import { Duration, Effect, Exit, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { ContactRow, ContactsImpl, ContactViewData } from "../../../src/modules/contacts";
import {
  ContactSnapshots,
  ContactsLive,
  ContactsRepo,
  ContactsTestLayer,
  FakeContactSeries,
} from "../../../src/modules/contacts";
import type { FakeSeries } from "../../../src/modules/contacts/series";
import { RegistryLookup } from "../../../src/modules/workspaces/registry";
import type { WorkspaceBillingDefaults } from "../../../src/shared/overrides";
import { resolveDocumentDefaults, resolveReminders } from "../../../src/shared/overrides";
import type { CoreStore } from "../../../src/store/CoreStore";
import { StoreUnavailable } from "../../../src/store/CoreStore";
import { FakeCompanyRegistry } from "../../../src/testing";
import {
  account,
  member,
  runTest,
  shareVisitor,
  system,
  TEST_NOW,
  WORKSPACE_A,
  WORKSPACE_B,
} from "../../helpers";
import {
  ACME_ICO,
  acmeRecord,
  as,
  BAD_ICO,
  CEZ_ICO,
  contactInput,
  expectFailure,
  failureOf,
  history,
  registry,
  successOf,
  UNKNOWN_ICO,
} from "./harness";

const run = <A, E>(
  caller: Caller,
  effect: Effect.Effect<
    A,
    E,
    | Contacts
    | ContactSnapshots
    | ContactsRepo
    | FakeCompanyRegistry
    | FakeContactSeries
    | CoreStore
    | CurrentCaller
  >,
) => runTest(caller, Effect.provide(effect, ContactsTestLayer), { registry });

const owner = member("owner");
const view = (v: ContactView) => v as ContactViewData;

const saveAcme = (fields: Record<string, unknown> = {}) =>
  Effect.flatMap(Contacts, (c) =>
    c.save(contactInput({ name: "Acme s.r.o.", ico: ACME_ICO, ...fields })),
  ).pipe(Effect.map(view));

describe("Contacts.save", () => {
  test("creates a Contact with defaults filled and audits contact.save", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const saved = yield* saveAcme({ billingEmails: ["fakturace@acme.cz"] });
        const entries = yield* history(WORKSPACE_A, { entity: "Contact", id: saved.id });
        return { saved, entries };
      }),
    );
    const { saved, entries } = successOf(exit);
    expect(saved).toMatchObject({
      roles: ["customer"],
      name: "Acme s.r.o.",
      ico: ACME_ICO,
      dic: null,
      address: { street: null, city: null, postalCode: null, country: "CZ" },
      billingEmails: ["fakturace@acme.cz"],
      defaults: { reminderPolicy: { mode: "inherit" } },
      archived: false,
      revision: 1,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "contact.save",
      revision: 1,
      actor: { _tag: "Member" },
    });
    expect(entries[0]?.changes.map((c) => c.path)).toContain("name");
  });

  test("edits with expectedRevision; patch keeps absent fields, null clears", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const created = yield* saveAcme({ phone: "+420 111", note: "VIP" });
        const edited = view(
          yield* contacts.save(
            contactInput({ id: created.id, expectedRevision: 1, note: null, roles: ["supplier"] }),
          ),
        );
        const entries = yield* history(WORKSPACE_A, { entity: "Contact", id: created.id });
        return { edited, entries };
      }),
    );
    const { edited, entries } = successOf(exit);
    expect(edited).toMatchObject({
      name: "Acme s.r.o.",
      phone: "+420 111",
      note: null,
      roles: ["supplier"],
      revision: 2,
    });
    expect(entries.map((e) => e.revision)).toEqual([1, 2]);
    expect(entries[1]?.changes).toEqual([
      { path: "roles", before: ["customer"], after: ["supplier"] },
      { path: "note", before: "VIP", after: null },
    ]);
  });

  test("a stale or missing expectedRevision is Conflict{revision_changed, currentRevision}", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const created = yield* saveAcme();
        yield* contacts.save(contactInput({ id: created.id, expectedRevision: 1, note: "x" }));
        const stale = yield* Effect.flip(
          contacts.save(contactInput({ id: created.id, expectedRevision: 1, note: "y" })),
        );
        const missing = yield* Effect.flip(
          contacts.save(contactInput({ id: created.id, note: "y" })),
        );
        return { stale, missing };
      }),
    );
    const { stale, missing } = successOf(exit);
    expect(stale).toMatchObject({
      _tag: "Conflict",
      reason: "revision_changed",
      currentRevision: 2,
    });
    expect(missing).toMatchObject({
      _tag: "Conflict",
      reason: "revision_changed",
      currentRevision: 2,
    });
  });

  test("an unchanged save writes nothing and keeps the revision", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const created = yield* saveAcme();
        const same = view(
          yield* (yield* Contacts).save(
            contactInput({ id: created.id, expectedRevision: 1, name: "Acme s.r.o." }),
          ),
        );
        return [same, yield* history(WORKSPACE_A, { entity: "Contact", id: created.id })] as const;
      }),
    );
    const [same, entries] = successOf(exit);
    expect(same.revision).toBe(1);
    expect(entries).toHaveLength(1);
  });

  test("IČO checksum fails before any write: Invalid{ico.checksum} at ico", async () => {
    const exit = await run(owner, saveAcme({ ico: BAD_ICO }));
    expectFailure(exit, { _tag: "Invalid", issues: [{ path: ["ico"], code: "ico.checksum" }] });
  });

  test("unknown fields, malformed ids and revisions, and non-objects are Invalid before any write", async () => {
    const save = (input: unknown) =>
      run(
        owner,
        Effect.flatMap(Contacts, (c) => c.save(input as never)),
      );
    expectFailure(await save({ name: "Acme", nmae: "typo" }), {
      _tag: "Invalid",
      issues: [{ path: ["nmae"], code: "request.malformed" }],
    });
    expectFailure(await save({ name: "Acme", id: "not-a-uuid", expectedRevision: 1 }), {
      issues: [{ path: ["id"], code: "request.malformed" }],
    });
    expectFailure(
      await save({
        name: "Acme",
        id: "01900000-0000-7000-8000-000000000001",
        expectedRevision: "1",
      }),
      { issues: [{ path: ["expectedRevision"], code: "request.malformed" }] },
    );
    expectFailure(await save([{ name: "Acme" }]), { _tag: "Invalid" });
    expectFailure(await save(null), { _tag: "Invalid" });
  });

  test("malformed open fields are Invalid{request.malformed} at their path", async () => {
    const noName = await run(
      owner,
      Effect.flatMap(Contacts, (c) => c.save(contactInput({ ico: ACME_ICO }))),
    );
    expectFailure(noName, {
      _tag: "Invalid",
      issues: [{ path: ["name"], code: "request.malformed" }],
    });
    const badEmail = await run(owner, saveAcme({ billingEmails: ["ok@acme.cz", "nope"] }));
    expectFailure(badEmail, {
      _tag: "Invalid",
      issues: [{ path: ["billingEmails", 1], code: "request.malformed" }],
    });
    const negativeDue = await run(owner, saveAcme({ defaults: { dueDays: -1 } }));
    expectFailure(negativeDue, {
      issues: [{ path: ["defaults", "dueDays"], code: "request.malformed" }],
    });
  });

  test("duplicate active IČO is Conflict{duplicate}; archiving frees the IČO", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const first = yield* saveAcme();
        const duplicate = yield* Effect.flip(saveAcme({ name: "Acme again" }));
        const other = yield* saveAcme({ name: "ČEZ", ico: CEZ_ICO });
        const moveOnto = yield* Effect.flip(
          contacts.save(contactInput({ id: other.id, expectedRevision: 1, ico: ACME_ICO })),
        );
        yield* contacts.archive(first.id);
        const second = yield* saveAcme({ name: "Acme reborn" });
        return { duplicate, moveOnto, second };
      }),
    );
    const { duplicate, moveOnto, second } = successOf(exit);
    expect(duplicate).toMatchObject({ _tag: "Conflict", reason: "duplicate" });
    expect(moveOnto).toMatchObject({ _tag: "Conflict", reason: "duplicate" });
    expect(second.name).toBe("Acme reborn");
  });

  test("requestKey replays the stored result; another payload is idempotency_mismatch", async () => {
    const key = "01900000-0000-7000-8000-0000000000aa" as RequestKey;
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const input = contactInput({ name: "Acme s.r.o.", ico: ACME_ICO });
        const first = view(yield* contacts.save(input, { requestKey: key }));
        const replay = view(yield* contacts.save(input, { requestKey: key }));
        const mismatch = yield* Effect.flip(
          contacts.save(contactInput({ name: "Other" }), { requestKey: key }),
        );
        const page = yield* contacts.search({});
        return { first, replay, mismatch, count: page.items.length };
      }),
    );
    const { first, replay, mismatch, count } = successOf(exit);
    expect(replay).toEqual(first);
    expect(count).toBe(1);
    expect(mismatch).toMatchObject({ _tag: "Conflict", reason: "idempotency_mismatch" });
  });
});

describe("Contacts authorization and tenancy", () => {
  const created = (caller: Caller) =>
    run(
      owner,
      Effect.gen(function* () {
        const saved = yield* saveAcme();
        const contacts = yield* Contacts;
        const exits = yield* as(caller)(
          Effect.all({
            get: Effect.exit(contacts.get(saved.id)),
            search: Effect.exit(contacts.search({})),
            save: Effect.exit(
              contacts.save(contactInput({ id: saved.id, expectedRevision: 1, note: "n" })),
            ),
            create: Effect.exit(contacts.save(contactInput({ name: "New" }))),
            archive: Effect.exit(contacts.archive(saved.id)),
            fromIco: Effect.exit(contacts.fromIco(ACME_ICO)),
          }),
        );
        return exits;
      }),
    ).then(successOf);

  const tagOf = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isSuccess(exit) ? "ok" : (failureOf(exit) as { _tag: string })._tag;
  const tags = (exits: Record<string, Exit.Exit<unknown, unknown>>) =>
    Object.fromEntries(Object.entries(exits).map(([k, v]) => [k, tagOf(v)]));

  test("member and admin read and write", async () => {
    for (const role of ["admin", "member"] as const) {
      expect(tags(await created(member(role)))).toEqual({
        get: "ok",
        search: "ok",
        save: "ok",
        create: "ok",
        archive: "ok",
        fromIco: "ok",
      });
    }
  });

  test("accountant is read-only", async () => {
    const exits = await created(member("accountant"));
    expect(tags(exits)).toEqual({
      get: "ok",
      search: "ok",
      save: "Forbidden",
      create: "Forbidden",
      archive: "Forbidden",
      fromIco: "Forbidden",
    });
    expectFailure(exits.save, { action: "contact.write" });
  });

  test("an API key limited to contacts:read reads only; documents-only keys see nothing", async () => {
    expect(tags(await created(member("owner", { scopes: ["contacts:read"] })))).toEqual({
      get: "ok",
      search: "ok",
      save: "Forbidden",
      create: "Forbidden",
      archive: "Forbidden",
      fromIco: "Forbidden",
    });
    const documentsOnly = await created(member("owner", { scopes: ["documents:write"] }));
    expect(new Set(Object.values(tags(documentsOnly)))).toEqual(new Set(["Forbidden"]));
    expectFailure(documentsOnly.get, { action: "contact.read" });
  });

  test("System callers read; Account and share visitors are Forbidden", async () => {
    expect(tags(await created(system()))).toMatchObject({ get: "ok", save: "Forbidden" });
    for (const caller of [account(), shareVisitor()]) {
      expect(new Set(Object.values(tags(await created(caller))))).toEqual(new Set(["Forbidden"]));
    }
  });

  test("another Workspace's Contact is NotFound for get, save and archive", async () => {
    const exits = await created(member("owner", { workspaceId: WORKSPACE_B }));
    for (const exit of [exits.get, exits.save, exits.archive]) {
      expectFailure(exit, { _tag: "NotFound", entity: "Contact" });
    }
    const search = exits.search;
    expect(
      Exit.isSuccess(search) && (search.value as unknown as { items: unknown[] }).items,
    ).toEqual([]);
  });

  test("Forbidden comes before the request-log replay (rule R1a)", async () => {
    const key = "01900000-0000-7000-8000-0000000000ab" as RequestKey;
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const input = contactInput({ name: "Acme" });
        yield* contacts.save(input, { requestKey: key });
        return yield* Effect.flip(
          as(member("accountant"))(contacts.save(input, { requestKey: key })),
        );
      }),
    );
    expect(successOf(exit)).toMatchObject({ _tag: "Forbidden", action: "contact.write" });
  });

  test("fromIco under sustained contention is Unavailable{database}, not a defect", async () => {
    // Scripted race: each lookup finds an active holder that is archived by the time it is locked.
    const holder = (archivedAt: string | null): ContactRow => ({
      id: "01900000-0000-7000-8000-0000000000c7" as ContactId,
      workspaceId: WORKSPACE_A,
      revision: 1,
      roles: ["customer"],
      name: "Acme",
      ico: ACME_ICO,
      dic: null,
      legalForm: null,
      address: { street: null, city: null, postalCode: null, country: "CZ" },
      billingEmails: [],
      phone: null,
      note: null,
      defaults: { reminderPolicy: { mode: "inherit" } },
      registryFetchedAt: null,
      archivedAt,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    const unused = () => Effect.die("not used by fromIco");
    const racing = Layer.succeed(ContactsRepo, {
      get: unused,
      getForUpdate: unused,
      lock: () => Effect.succeed(holder("2026-11-23T09:00:00.000Z")),
      findActiveByIco: () => Effect.succeed(Option.some(holder(null))),
      insert: unused,
      update: unused,
      search: unused,
    });
    const layer = ContactsLive.pipe(
      Layer.provide(racing),
      Layer.provide(RegistryLookup.layer),
      Layer.provide(FakeContactSeries.layer),
    );
    const exit = await runTest(
      owner,
      Effect.provide(
        Effect.flatMap(Contacts, (c) => c.fromIco(ACME_ICO)),
        layer,
      ),
      { registry },
    );
    expect(failureOf(exit) as unknown).toEqual(new Unavailable({ dependency: "database" }));
  });

  test("store failures are Unavailable{database}", async () => {
    const failing = Layer.succeed(ContactsRepo, {
      get: () => Effect.fail(new StoreUnavailable({})),
      getForUpdate: () => Effect.fail(new StoreUnavailable({})),
      lock: () => Effect.fail(new StoreUnavailable({})),
      findActiveByIco: () => Effect.fail(new StoreUnavailable({})),
      insert: () => Effect.fail(new StoreUnavailable({})),
      update: () => Effect.fail(new StoreUnavailable({})),
      search: () => Effect.fail(new StoreUnavailable({})),
    });
    const layer = ContactsLive.pipe(
      Layer.provide(failing),
      Layer.provide(RegistryLookup.layer),
      Layer.provide(FakeContactSeries.layer),
    );
    const exit = await runTest(
      owner,
      Effect.provide(
        Effect.flatMap(Contacts, (c) => c.get("01900000-0000-7000-8000-000000000099" as ContactId)),
        layer,
      ),
    );
    expect(failureOf(exit) as unknown).toEqual(new Unavailable({ dependency: "database" }));
  });
});

describe("Contacts.fromIco", () => {
  test("creates a Contact from the registry; never infers VAT-payer status from DIČ", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const saved = view(yield* (yield* Contacts).fromIco(ACME_ICO, { role: "supplier" }));
        const entries = yield* history(WORKSPACE_A, { entity: "Contact", id: saved.id });
        return { saved, entries };
      }),
    );
    const { saved, entries } = successOf(exit);
    expect(saved).toMatchObject({
      roles: ["supplier"],
      name: "Acme s.r.o.",
      ico: ACME_ICO,
      dic: "CZ27074358",
      legalForm: "112",
      address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
      registryFetchedAt: new Date(TEST_NOW).toISOString(),
      revision: 1,
    });
    expect(Object.keys(saved).some((k) => /vat/i.test(k))).toBe(false);
    expect(entries.map((e) => e.action)).toEqual(["contact.save"]);
  });

  test("upserts by IČO: reuses the active Contact, adds the role, keeps user fields; cache reused", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const fake = yield* FakeCompanyRegistry;
        const manual = yield* saveAcme({ name: "Acme (manual)", phone: "+420 222" });
        const first = view(yield* contacts.fromIco(ACME_ICO));
        const second = view(yield* contacts.fromIco(ACME_ICO, { role: "supplier" }));
        const third = view(yield* contacts.fromIco(ACME_ICO, { role: "supplier" }));
        const lookups = yield* Ref.get(fake.lookups);
        return { manual, first, second, third, lookups };
      }),
    );
    const { manual, first, second, third, lookups } = successOf(exit);
    expect(first.id).toBe(manual.id);
    expect(first).toMatchObject({ name: "Acme s.r.o.", phone: "+420 222", revision: 2 });
    expect(second).toMatchObject({ roles: ["customer", "supplier"], revision: 3 });
    expect(third.revision).toBe(3);
    expect(lookups).toEqual([ACME_ICO]);
  });

  test("the cache expires after 24 hours", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const fake = yield* FakeCompanyRegistry;
        yield* contacts.fromIco(ACME_ICO);
        yield* TestClock.adjust(Duration.hours(25));
        yield* contacts.fromIco(ACME_ICO);
        return yield* Ref.get(fake.lookups);
      }),
    );
    expect(successOf(exit)).toEqual([ACME_ICO, ACME_ICO]);
  });

  test("checksum failure is Invalid{ico.checksum} with no registry call", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Contacts).fromIco(BAD_ICO));
        return { error, lookups: yield* Ref.get((yield* FakeCompanyRegistry).lookups) };
      }),
    );
    const { error, lookups } = successOf(exit);
    expect(error).toMatchObject({ _tag: "Invalid", issues: [{ code: "ico.checksum" }] });
    expect(lookups).toEqual([]);
  });

  test("registry outage is Unavailable{company_registry} and saves nothing", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        yield* Ref.set((yield* FakeCompanyRegistry).unavailable, true);
        const error = yield* Effect.flip(contacts.fromIco(ACME_ICO));
        return { error, page: yield* contacts.search({}) };
      }),
    );
    const { error, page } = successOf(exit);
    expect(error).toEqual(new Unavailable({ dependency: "company_registry" }));
    expect(page.items).toEqual([]);
  });

  test("registry names are trimmed; a registry without DIČ keeps the user's; fetch time recorded", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const fresh = view(yield* contacts.fromIco(CEZ_ICO));
        yield* contacts.archive(fresh.id);
        const manual = yield* saveAcme({
          name: "Acme s.r.o.",
          dic: "CZ27074358",
          legalForm: "112",
          address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
        });
        const refreshed = view(yield* contacts.fromIco(ACME_ICO));
        const cezManual = yield* saveAcme({ name: "ČEZ", ico: CEZ_ICO, dic: "CZ45274649" });
        const cez = view(yield* contacts.fromIco(CEZ_ICO));
        return { fresh, manual, refreshed, cezManual, cez };
      }),
    );
    const { fresh, manual, refreshed, cezManual, cez } = successOf(exit);
    expect(fresh).toMatchObject({ name: "ČEZ, a. s.", dic: null });
    // Same particulars as the registry: still records the fetch, as one audited write.
    expect(manual.registryFetchedAt).toBeNull();
    expect(refreshed).toMatchObject({ id: manual.id, revision: 2 });
    expect(refreshed.registryFetchedAt).not.toBeNull();
    expect(cez).toMatchObject({ id: cezManual.id, name: "ČEZ, a. s.", dic: "CZ45274649" });
  });

  test("an IČO the registry does not know is NotFound", async () => {
    const exit = await run(
      owner,
      Effect.flatMap(Contacts, (c) => c.fromIco(UNKNOWN_ICO)),
    );
    expectFailure(exit, { _tag: "NotFound", entity: "Contact", id: UNKNOWN_ICO });
  });

  test("an archived Contact with the IČO is left alone; a new active one is created", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const old = view(yield* contacts.fromIco(ACME_ICO));
        yield* contacts.archive(old.id);
        const fresh = view(yield* contacts.fromIco(ACME_ICO));
        return { old: view(yield* contacts.get(old.id)), fresh };
      }),
    );
    const { old, fresh } = successOf(exit);
    expect(fresh.id).not.toBe(old.id);
    expect(old).toMatchObject({ archived: true, revision: 2 });
  });
});

describe("Contacts.archive and get", () => {
  test("archive is idempotent by state and audited once; get still returns the Contact", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const saved = yield* saveAcme();
        yield* contacts.archive(saved.id);
        yield* contacts.archive(saved.id);
        return {
          got: view(yield* contacts.get(saved.id)),
          entries: yield* history(WORKSPACE_A, { entity: "Contact", id: saved.id }),
        };
      }),
    );
    const { got, entries } = successOf(exit);
    expect(got).toMatchObject({ archived: true, revision: 2 });
    expect(entries.map((e) => e.action)).toEqual(["contact.save", "contact.archive"]);
  });

  test("unknown ids are NotFound", async () => {
    const id = "01900000-0000-7000-8000-000000000099" as ContactId;
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        return [
          yield* Effect.exit(contacts.get(id)),
          yield* Effect.exit(contacts.archive(id)),
        ] as const;
      }),
    );
    for (const e of successOf(exit)) expectFailure(e, { _tag: "NotFound", entity: "Contact", id });
  });
});

describe("Contacts.search", () => {
  const seed = Effect.gen(function* () {
    const contacts = yield* Contacts;
    const save = (fields: Record<string, unknown>) =>
      Effect.map(contacts.save(contactInput(fields)), view);
    const zluty = yield* save({ name: "Žluťoučký kůň s.r.o.", roles: ["supplier"] });
    const acme = yield* save({ name: "Acme s.r.o.", ico: ACME_ICO });
    const beta = yield* save({
      name: "Beta a.s.",
      roles: ["customer", "supplier"],
      billingEmails: ["ucetni@beta.cz"],
    });
    const gone = yield* save({ name: "Archived Acme" });
    yield* contacts.archive(gone.id);
    return { zluty, acme, beta, gone };
  });

  test("orders by name, filters by text (diacritics-insensitive) and role, skips archived", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        yield* seed;
        const names = (q: Parameters<Contacts["Service"]["search"]>[0]) =>
          Effect.map(contacts.search(q), (p) => p.items.map((c) => view(c).name));
        return {
          all: yield* names({}),
          zlutou: yield* names({ text: "zlutou" }),
          byIco: yield* names({ text: ACME_ICO.slice(0, 5) }),
          byEmail: yield* names({ text: "UCETNI@" }),
          suppliers: yield* names({ role: "supplier" }),
          customers: yield* names({ role: "customer", text: "a" }),
        };
      }),
    );
    expect(successOf(exit)).toEqual({
      all: ["Acme s.r.o.", "Beta a.s.", "Žluťoučký kůň s.r.o."],
      zlutou: ["Žluťoučký kůň s.r.o."],
      byIco: ["Acme s.r.o."],
      byEmail: ["Beta a.s."],
      suppliers: ["Beta a.s.", "Žluťoučký kůň s.r.o."],
      customers: ["Acme s.r.o.", "Beta a.s."],
    });
  });

  test("pages by cursor; a cursor from another filter is Invalid{page.cursor_mismatch}", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        for (let i = 0; i < 52; i++) {
          yield* contacts.save(contactInput({ name: `Firma ${String(i).padStart(2, "0")}` }));
        }
        const first = yield* contacts.search({ text: "firma" });
        const second = yield* contacts.search({
          text: "firma",
          ...(first.nextCursor !== null ? { cursor: first.nextCursor } : {}),
        });
        const mismatch = yield* Effect.flip(
          contacts.search({ text: "other", cursor: first.nextCursor ?? "" }),
        );
        const garbage = yield* Effect.flip(contacts.search({ cursor: "%%%" }));
        return { first, second, mismatch, garbage };
      }),
    );
    const { first, second, mismatch, garbage } = successOf(exit);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor?.length ?? 0).toBeLessThan(64);
    expect(second.items.map((c) => view(c).name)).toEqual(["Firma 50", "Firma 51"]);
    expect(second.nextCursor).toBeNull();
    for (const error of [mismatch, garbage]) {
      expect(error).toMatchObject({
        _tag: "Invalid",
        issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }],
      });
    }
  });
});

describe("Contacts.search paging edges", () => {
  test("limit sizes the page (1 to 100); out of range is Invalid{request.malformed} at limit", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts; // the public tag takes `limit`
        for (const name of ["A", "B", "C"]) yield* contacts.save(contactInput({ name }));
        const one = yield* contacts.search({ limit: 1 });
        const rest = yield* contacts.search({ limit: 2, cursor: one.nextCursor ?? "" });
        const bad = yield* Effect.all(
          [0, 101, 1.5].map((limit) => Effect.flip(contacts.search({ limit }))),
        );
        return { one, rest, bad };
      }),
    );
    const { one, rest, bad } = successOf(exit);
    expect(one.items.map((c) => c.name)).toEqual(["A"]);
    expect(rest.items.map((c) => c.name)).toEqual(["B", "C"]);
    expect(rest.nextCursor).toBeNull();
    for (const error of bad) {
      expect(error).toMatchObject({ issues: [{ path: ["limit"], code: "request.malformed" }] });
    }
  });

  test("a cursor whose anchor row changed is stale: Invalid{page.cursor_mismatch}", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts as unknown as Effect.Effect<ContactsImpl>;
        for (const name of ["A", "B", "C"]) yield* contacts.save(contactInput({ name }));
        const first = yield* contacts.search({ limit: 2 });
        const anchor = first.items[1];
        if (anchor === undefined || first.nextCursor === null) return yield* Effect.die("setup");
        // Any write to the anchor invalidates the cursor: a rename, and an edit that keeps the name.
        yield* contacts.save(contactInput({ id: anchor.id, expectedRevision: 1, name: "ZZ" }));
        const renamed = yield* Effect.flip(contacts.search({ limit: 2, cursor: first.nextCursor }));
        const again = yield* contacts.search({ limit: 2 });
        if (again.nextCursor === null) return yield* Effect.die("setup");
        const anchor2 = again.items[1];
        if (anchor2 === undefined) return yield* Effect.die("setup");
        yield* contacts.save(
          contactInput({ id: anchor2.id, expectedRevision: anchor2.revision, note: "x" }),
        );
        const touched = yield* Effect.flip(contacts.search({ limit: 2, cursor: again.nextCursor }));
        return { renamed, touched };
      }),
    );
    const { renamed, touched } = successOf(exit);
    for (const error of [renamed, touched]) {
      expect(error).toMatchObject({
        _tag: "Invalid",
        issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }],
      });
    }
  });
});

const seedSeries = (series: ReadonlyArray<FakeSeries>) =>
  Effect.flatMap(FakeContactSeries, (fake) => Ref.set(fake.series, series));

describe("Contact preferred series", () => {
  const mine = "01900000-0000-7000-8000-0000000005f1" as NumberingSeriesId;
  const theirs = "01900000-0000-7000-8000-0000000005f2" as NumberingSeriesId;
  const unknown = "01900000-0000-7000-8000-0000000005f3" as NumberingSeriesId;

  test("a missing, foreign or wrong-kind series is NotFound{NumberingSeries}, on create and edit", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        yield* seedSeries([
          { workspaceId: WORKSPACE_A, id: mine, kind: "invoice" },
          { workspaceId: WORKSPACE_B, id: theirs, kind: "invoice" },
        ]);
        const attempt = (preferredSeriesByKind: Record<string, NumberingSeriesId>) =>
          Effect.flip(saveAcme({ defaults: { preferredSeriesByKind } }));
        const failures = {
          unknown: yield* attempt({ invoice: unknown }),
          foreign: yield* attempt({ invoice: theirs }),
          wrongKind: yield* attempt({ proforma: mine }),
        };
        const ok = yield* saveAcme({ defaults: { preferredSeriesByKind: { invoice: mine } } });
        const edit = yield* Effect.flip(
          contacts.save(
            contactInput({
              id: ok.id,
              expectedRevision: 1,
              defaults: { preferredSeriesByKind: { invoice: theirs } },
            }),
          ),
        );
        yield* contacts.save(contactInput({ id: ok.id, expectedRevision: 1, note: "rev 2" }));
        // Stale revision wins over the series rule (C2): checked first.
        const staleWithBadSeries = yield* Effect.flip(
          contacts.save(
            contactInput({
              id: ok.id,
              expectedRevision: 1,
              defaults: { preferredSeriesByKind: { invoice: unknown } },
            }),
          ),
        );
        return { failures, ok, edit, staleWithBadSeries };
      }),
    );
    const { failures, ok, edit, staleWithBadSeries } = successOf(exit);
    expect(staleWithBadSeries).toMatchObject({
      _tag: "Conflict",
      reason: "revision_changed",
      currentRevision: 2,
    });
    expect(failures.unknown).toMatchObject({
      _tag: "NotFound",
      entity: "NumberingSeries",
      id: unknown,
    });
    expect(failures.foreign).toMatchObject({
      _tag: "NotFound",
      entity: "NumberingSeries",
      id: theirs,
    });
    expect(failures.wrongKind).toMatchObject({
      _tag: "NotFound",
      entity: "NumberingSeries",
      id: mine,
    });
    expect(ok.defaults.preferredSeriesByKind).toEqual({ invoice: mine });
    expect(edit).toMatchObject({ _tag: "NotFound", entity: "NumberingSeries", id: theirs });
  });
});

describe("Contact overrides", () => {
  const workspace: WorkspaceBillingDefaults = {
    currency: "CZK" as CurrencyCode,
    language: "cs",
    dueDays: 14,
    paymentMethod: "bank_transfer",
    seriesByKind: { invoice: "01900000-0000-7000-8000-0000000005e1" as NumberingSeriesId },
    defaultNote: "Děkujeme",
  };
  const contactSeries = "01900000-0000-7000-8000-0000000005e2" as NumberingSeriesId;

  test("Contact overrides win over the Workspace; absent ones fall back", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        yield* seedSeries([{ workspaceId: WORKSPACE_A, id: contactSeries, kind: "proforma" }]);
        return yield* saveAcme({
          defaults: {
            currency: "EUR",
            dueDays: 30,
            preferredSeriesByKind: { proforma: contactSeries },
          },
        });
      }),
    );
    const saved = successOf(exit);
    expect(saved.defaults).toEqual({
      currency: "EUR" as CurrencyCode,
      dueDays: 30,
      preferredSeriesByKind: { proforma: contactSeries },
      reminderPolicy: { mode: "inherit" },
    });
    expect(
      resolveDocumentDefaults({ kind: "invoice", contact: saved.defaults, workspace }),
    ).toEqual({
      currency: "EUR" as CurrencyCode,
      language: "cs",
      dueDays: 30,
      paymentMethod: "bank_transfer",
      series: workspace.seriesByKind.invoice ?? null,
      note: "Děkujeme",
    });
    expect(
      resolveDocumentDefaults({
        kind: "proforma",
        document: { dueDays: 7 },
        contact: saved.defaults,
        workspace,
      }),
    ).toMatchObject({ dueDays: 7, series: contactSeries });
  });

  test("reminderPolicy inherit | disabled | custom round-trips and drives resolveReminders", async () => {
    const reminders = { enabled: true, proformas: false, offsetsDays: [3, 10] };
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const contacts = yield* Contacts;
        const save = (name: string, defaults?: unknown) =>
          Effect.map(
            contacts.save(contactInput({ name, ...(defaults ? { defaults } : {}) })),
            view,
          );
        return {
          inherit: yield* save("Inherit"),
          disabled: yield* save("Disabled", { reminderPolicy: { mode: "disabled" } }),
          custom: yield* save("Custom", {
            reminderPolicy: { mode: "custom", offsetsDays: [1, 5] },
          }),
          negative: yield* Effect.flip(
            save("Bad", { reminderPolicy: { mode: "custom", offsetsDays: [1, -2] } }),
          ),
        };
      }),
    );
    const { inherit, disabled, custom, negative } = successOf(exit);
    const resolve = (c: ContactViewData, choice: "on" | "off" | "inherit" = "inherit") =>
      resolveReminders({
        kind: "invoice",
        choice,
        contact: c.defaults.reminderPolicy,
        workspace: reminders,
      });
    expect(inherit.defaults.reminderPolicy).toEqual({ mode: "inherit" });
    expect(resolve(inherit)).toEqual({ arms: true, offsetsDays: [3, 10] });
    expect(resolve(disabled)).toEqual({ arms: false, offsetsDays: [] });
    expect(resolve(disabled, "on")).toEqual({ arms: true, offsetsDays: [3, 10] });
    expect(resolve(custom)).toEqual({ arms: true, offsetsDays: [1, 5] });
    expect(negative).toMatchObject({
      issues: [{ path: ["defaults", "reminderPolicy", "offsetsDays", 1] }],
    });
  });

  test("defaults on edit replace the whole override set", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const created = yield* saveAcme({ defaults: { currency: "EUR", dueDays: 30 } });
        return view(
          yield* (yield* Contacts).save(
            contactInput({ id: created.id, expectedRevision: 1, defaults: { dueDays: 10 } }),
          ),
        );
      }),
    );
    expect(successOf(exit).defaults).toEqual({ dueDays: 10, reminderPolicy: { mode: "inherit" } });
  });
});

describe("ContactSnapshots (Documents read port)", () => {
  test("returns party particulars and overrides without contact.read; scoped by Workspace", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const saved = view(yield* (yield* Contacts).fromIco(ACME_ICO));
        const snapshots = yield* ContactSnapshots;
        const forDocument = yield* as(member("owner", { scopes: ["documents:write"] }))(
          snapshots.forDocument(WORKSPACE_A, saved.id),
        );
        const elsewhere = yield* Effect.flip(snapshots.forDocument(WORKSPACE_B, saved.id));
        return { saved, forDocument, elsewhere };
      }),
    );
    const { saved, forDocument, elsewhere } = successOf(exit);
    expect(forDocument).toEqual({
      party: {
        contactId: saved.id,
        name: acmeRecord.name,
        ico: ACME_ICO,
        dic: "CZ27074358",
        legalForm: "112",
        address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
      },
      defaults: { reminderPolicy: { mode: "inherit" } },
      roles: ["customer"],
      billingEmails: [],
      archived: false,
      revision: 1,
    });
    expect(elsewhere).toMatchObject({ _tag: "NotFound", entity: "Contact" });
  });
});
