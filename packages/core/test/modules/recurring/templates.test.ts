import { describe, expect, test } from "bun:test";
import type { IsoDate, RequestKey, TemplateId, TemplateSchedule } from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, NotFound, Templates } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit } from "effect";
import type { TemplateViewValue } from "../../../src/modules/recurring";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { as, DocumentsStub, ok, scenario, templateInput } from "./fixtures";

const KEY = "req-template-1" as RequestKey;
const view = (v: unknown) => v as TemplateViewValue;
const MONTHLY: TemplateSchedule = {
  every: { months: 1 },
  startOn: "2026-12-01" as IsoDate,
  issueAs: "invoice",
  autoSend: false,
};

const create = Effect.flatMap(Templates, (t) => t.save(templateInput()));

describe("Templates.save", () => {
  test("creates a template at revision 1 and audits it", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const created = view(yield* create);
        const store = yield* CoreStore;
        const history = yield* store.audit.history(WORKSPACE_A, {
          entity: "Template",
          id: created.id,
        });
        return { created, actions: history.map((e) => e.action) };
      }),
    );
    const { created, actions } = ok(exit);
    expect(created.revision).toBe(1);
    expect(created.name).toBe("Monthly hosting");
    expect(created.schedule).toBeNull();
    expect(created.archived).toBe(false);
    expect(actions).toEqual(["template.create"]);
  });

  test("updates with the expected revision and rejects a stale one", async () => {
    const exit = await scenario(
      member("member"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const created = view(yield* t.save(templateInput()));
        const updated = view(
          yield* t.save({
            ...templateInput({ name: "Hosting" }),
            id: created.id,
            expectedRevision: 1,
          }),
        );
        const stale = yield* Effect.exit(
          t.save({ ...templateInput({ name: "Other" }), id: created.id, expectedRevision: 1 }),
        );
        const missing = yield* Effect.exit(t.save({ ...templateInput(), id: created.id }));
        return { updated, stale, missing };
      }),
    );
    const { updated, stale, missing } = ok(exit);
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe("Hosting");
    expect(stale).toEqual(
      Exit.fail(new Conflict({ reason: "revision_changed", currentRevision: 2 })),
    );
    expect(missing).toEqual(
      Exit.fail(new Conflict({ reason: "revision_changed", currentRevision: 2 })),
    );
  });

  test("rejects an empty name and a negative relative due", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const name = yield* Effect.exit(t.save(templateInput({ name: "  " })));
        const due = yield* Effect.exit(t.save(templateInput({ due: { inDays: -1 } })));
        return { name, due };
      }),
    );
    const { name, due } = ok(exit);
    expect(name).toEqual(
      Exit.fail(
        new Invalid({
          issues: [{ path: ["name"], code: "request.malformed", params: { reason: "empty" } }],
        }),
      ),
    );
    expect(due).toEqual(
      Exit.fail(
        new Invalid({ issues: [{ path: ["due", "inDays"], code: "document.due_before_issue" }] }),
      ),
    );
  });

  test("a replayed request key returns the stored view; a different payload conflicts", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const first = view(yield* t.save(templateInput(), { requestKey: KEY }));
        const replay = view(yield* t.save(templateInput(), { requestKey: KEY }));
        const mismatch = yield* Effect.exit(
          t.save(templateInput({ name: "Else" }), { requestKey: KEY }),
        );
        const all = yield* t.list;
        return { first, replay, mismatch, count: all.length };
      }),
    );
    const { first, replay, mismatch, count } = ok(exit);
    expect(replay.id).toBe(first.id);
    expect(count).toBe(1);
    const price = replay.input.lines[0].unitPrice;
    expect(
      price !== undefined && BigDecimal.equals(price, BigDecimal.fromStringUnsafe("1250.5")),
    ).toBe(true);
    expect(mismatch).toEqual(Exit.fail(new Conflict({ reason: "idempotency_mismatch" })));
  });
});

describe("Templates authorization", () => {
  test("accountant and read-scoped tokens read but cannot write", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const created = view(yield* t.save(templateInput()));
        const id = created.id as TemplateId;
        const accountant = member("accountant");
        const readToken = member("owner", { scopes: ["templates:read"] });
        const docsToken = member("owner", { scopes: ["documents:write"] });
        return {
          accountantGet: yield* Effect.exit(as(accountant)(t.get(id))),
          accountantSave: yield* Effect.exit(as(accountant)(t.save(templateInput()))),
          accountantSchedule: yield* Effect.exit(as(accountant)(t.schedule(id, MONTHLY, 1))),
          tokenList: yield* Effect.exit(as(readToken)(t.list)),
          tokenArchive: yield* Effect.exit(as(readToken)(t.archive(id))),
          docsTokenGet: yield* Effect.exit(as(docsToken)(t.get(id))),
        };
      }),
    );
    const r = ok(exit);
    expect(Exit.isSuccess(r.accountantGet)).toBe(true);
    expect(r.accountantSave).toEqual(Exit.fail(new Forbidden({ action: "template.write" })));
    expect(r.accountantSchedule).toEqual(Exit.fail(new Forbidden({ action: "schedule.write" })));
    expect(Exit.isSuccess(r.tokenList)).toBe(true);
    expect(r.tokenArchive).toEqual(Exit.fail(new Forbidden({ action: "template.write" })));
    expect(r.docsTokenGet).toEqual(Exit.fail(new Forbidden({ action: "template.read" })));
  });

  test("a System caller may not save, schedule, resume, archive or use (R4, R5)", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const job = system({
          _tag: "RecurringIssuance",
          scheduleId: "01900000-0000-7000-8000-00000000e001" as never,
          occurrence: "2026-11-23" as never,
        });
        const run = as(job);
        return {
          save: yield* Effect.exit(run(t.save(templateInput()))),
          schedule: yield* Effect.exit(run(t.schedule(id, MONTHLY, 1))),
          resume: yield* Effect.exit(run(t.resume(id))),
          archive: yield* Effect.exit(run(t.archive(id))),
          use: yield* Effect.exit(run(t.use(id, { as: "issued" }))),
        };
      }),
    );
    const r = ok(exit);
    expect(r.save).toEqual(Exit.fail(new Forbidden({ action: "template.write" })));
    expect(r.schedule).toEqual(Exit.fail(new Forbidden({ action: "schedule.write" })));
    expect(r.resume).toEqual(Exit.fail(new Forbidden({ action: "schedule.write" })));
    expect(r.archive).toEqual(Exit.fail(new Forbidden({ action: "template.write" })));
    expect(r.use).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
  });

  test("another Workspace's template is NotFound for every method (R2)", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const other = as(member("owner", { workspaceId: WORKSPACE_B }));
        return {
          id,
          results: [
            yield* Effect.exit(other(t.get(id))),
            yield* Effect.exit(other(t.save({ ...templateInput(), id, expectedRevision: 1 }))),
            yield* Effect.exit(other(t.archive(id))),
            yield* Effect.exit(other(t.schedule(id, MONTHLY, 1))),
            yield* Effect.exit(other(t.resume(id))),
            yield* Effect.exit(other(t.use(id))),
            yield* Effect.exit(other(t.runs(id))),
          ],
        };
      }),
    );
    const { id, results } = ok(exit);
    for (const result of results) {
      expect(result).toEqual(Exit.fail(new NotFound({ entity: "Template", id })));
    }
  });
});

describe("Templates.archive", () => {
  test("hides the template from list, detaches its schedule and blocks edits", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        yield* t.schedule(id, MONTHLY, 1);
        yield* t.archive(id);
        yield* t.archive(id); // idempotent by state (C6)
        const got = view(yield* t.get(id));
        const listed = yield* t.list;
        const edit = yield* Effect.exit(
          t.save({ ...templateInput(), id, expectedRevision: got.revision }),
        );
        const use = yield* Effect.exit(t.use(id));
        return { got, listed, edit, use };
      }),
    );
    const { got, listed, edit, use } = ok(exit);
    expect(got.archived).toBe(true);
    expect(got.schedule).toBeNull();
    expect(listed).toEqual([]);
    expect(edit).toEqual(Exit.fail(new Conflict({ reason: "illegal_transition" })));
    expect(use).toEqual(Exit.fail(new Conflict({ reason: "illegal_transition" })));
  });
});

describe("Templates.use", () => {
  test("creates a draft or issues with template values as defaults and the patch on top", async () => {
    const exit = await scenario(
      member("member"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const draft = yield* t.use(id);
        const issued = yield* t.use(id, {
          as: "issued",
          patch: { issuedOn: "2026-11-20" as never, note: "Thanks" },
        });
        const numberPatch = yield* Effect.exit(t.use(id, { patch: { number: "X-1" } }));
        const stub = yield* DocumentsStub;
        const docs = yield* stub.documents(WORKSPACE_A);
        return { draft, issued, numberPatch, docs };
      }),
    );
    const { draft, issued, numberPatch, docs } = ok(exit);
    expect(draft.status).toBe("draft");
    expect(issued.status).toBe("issued");
    const issuedRow = docs.find((d) => d.id === issued.id);
    expect(issuedRow?.input.due).toEqual({ inDays: 14 });
    expect(issuedRow?.input.issuedOn).toBe("2026-11-20" as never);
    expect(issuedRow?.input.note).toBe("Thanks");
    expect(issuedRow?.input).not.toHaveProperty("name");
    expect(issuedRow?.actor).toBe("Member");
    expect(Exit.isFailure(numberPatch)).toBe(true);
  });
});
