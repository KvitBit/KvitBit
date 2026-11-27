import { describe, expect, test } from "bun:test";
import type { CoreError, TemplateSchedule } from "@kvitbit/domain/contract";
import {
  Conflict,
  Forbidden,
  Invalid,
  IsoDate,
  NotFound,
  RequestKey,
  ScheduleId,
  TemplateId,
  Templates,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { withoutStackTrace } from "../../helpers/run";
import { as, DocumentsStub, ok, scenario, templateInput, templateView } from "./fixtures";

const KEY = RequestKey.make("req-template-1");
const MONTHLY: TemplateSchedule = {
  every: { months: 1 },
  startOn: IsoDate.make("2026-12-01"),
  issueAs: "invoice",
  autoSend: false,
};

const create = Effect.flatMap(Templates, (t) => t.save(templateInput()));

describe("Templates.save", () => {
  test("creates a template at revision 1 and audits it", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const created = yield* create.pipe(Effect.flatMap(templateView));
        const store = yield* CoreStore;
        const history = yield* store.audit.history(WORKSPACE_A, {
          entity: "Template",
          id: created.id,
        });
        return { created, actions: EffectArray.map(history, (e) => e.action) };
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
    const exit = await scenario(member("member"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const created = yield* templateView(saveResult);
        const saveResult2 = yield* t.save({
          ...templateInput({ name: "Hosting" }),
          id: created.id,
          expectedRevision: 1,
        });
        const updated = yield* templateView(saveResult2);
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
    expect(stale.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "revision_changed", currentRevision: 2 })),
    );
    expect(missing.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "revision_changed", currentRevision: 2 })),
    );
  });

  test("rejects an empty name and a negative relative due", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const name = yield* Effect.exit(t.save(templateInput({ name: "  " })));
        const due = yield* Effect.exit(t.save(templateInput({ due: { inDays: -1 } })));
        return { name, due };
      }),
    );
    const { name, due } = ok(exit);
    expect(name.pipe(withoutStackTrace)).toEqual(
      Exit.fail(
        Invalid.make({
          issues: [{ path: ["name"], code: "request.malformed", params: { reason: "empty" } }],
        }),
      ),
    );
    expect(due.pipe(withoutStackTrace)).toEqual(
      Exit.fail(
        Invalid.make({ issues: [{ path: ["due", "inDays"], code: "document.due_before_issue" }] }),
      ),
    );
  });

  test("a replayed request key returns the stored view; a different payload conflicts", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput(), { requestKey: KEY });
        const first = yield* templateView(saveResult);
        const saveResult2 = yield* t.save(templateInput(), { requestKey: KEY });
        const replay = yield* templateView(saveResult2);
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
    expect(mismatch.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "idempotency_mismatch" })),
    );
  });
});

describe("Templates authorization", () => {
  test("accountant and read-scoped tokens read but cannot write", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const created = yield* templateView(saveResult);
        const id = TemplateId.make(created.id);
        const accountant = member("accountant");
        const readToken = member("owner", { scopes: ["templates:read"] });
        const docsToken = member("owner", { scopes: ["documents:write"] });
        return {
          accountantGet: yield* t.get(id).pipe(as(accountant), Effect.exit),
          accountantSave: yield* t.save(templateInput()).pipe(as(accountant), Effect.exit),
          accountantSchedule: yield* t.schedule(id, MONTHLY, 1).pipe(as(accountant), Effect.exit),
          tokenList: yield* t.list.pipe(as(readToken), Effect.exit),
          tokenArchive: yield* t.archive(id).pipe(as(readToken), Effect.exit),
          docsTokenGet: yield* t.get(id).pipe(as(docsToken), Effect.exit),
        };
      }),
    );
    const r = ok(exit);
    expect(Exit.isSuccess(r.accountantGet)).toBe(true);
    expect(r.accountantSave.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "template.write" })),
    );
    expect(r.accountantSchedule.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "schedule.write" })),
    );
    expect(Exit.isSuccess(r.tokenList)).toBe(true);
    expect(r.tokenArchive.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "template.write" })),
    );
    expect(r.docsTokenGet.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "template.read" })),
    );
  });

  test("a System caller may not save, schedule, resume, archive or use (R4, R5)", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const id = (yield* templateView(saveResult)).id;
        const job = system({
          _tag: "RecurringIssuance",
          scheduleId: ScheduleId.make("01900000-0000-7000-8000-00000000e001"),
          occurrence: IsoDate.make("2026-11-23"),
        });
        const run = as(job);
        return {
          save: yield* t.save(templateInput()).pipe(run, Effect.exit),
          schedule: yield* t.schedule(id, MONTHLY, 1).pipe(run, Effect.exit),
          resume: yield* t.resume(id).pipe(run, Effect.exit),
          archive: yield* t.archive(id).pipe(run, Effect.exit),
          use: yield* t.use(id, { as: "issued" }).pipe(run, Effect.exit),
        };
      }),
    );
    const r = ok(exit);
    expect(r.save.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "template.write" })),
    );
    expect(r.schedule.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "schedule.write" })),
    );
    expect(r.resume.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "schedule.write" })),
    );
    expect(r.archive.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "template.write" })),
    );
    expect(r.use.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
  });

  test("another Workspace's template is NotFound for every method (R2)", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const id = (yield* templateView(saveResult)).id;
        const other = as(member("owner", { workspaceId: WORKSPACE_B }));
        return {
          id,
          results: [
            yield* t.get(id).pipe(other, Effect.exit),
            yield* t.save({ ...templateInput(), id, expectedRevision: 1 }).pipe(other, Effect.exit),
            yield* t.archive(id).pipe(other, Effect.exit),
            yield* t.schedule(id, MONTHLY, 1).pipe(other, Effect.exit),
            yield* t.resume(id).pipe(other, Effect.exit),
            yield* t.use(id).pipe(other, Effect.exit),
            yield* t.runs(id).pipe(other, Effect.exit),
          ],
        };
      }),
    );
    const { id, results } = ok(exit);
    for (const result of results) {
      const actual = withoutStackTrace<unknown, CoreError>(result);
      expect(actual).toEqual(Exit.fail(NotFound.make({ entity: "Template", id })));
    }
  });
});

describe("Templates.archive", () => {
  test("hides the template from list, detaches its schedule and blocks edits", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const id = (yield* templateView(saveResult)).id;
        yield* t.schedule(id, MONTHLY, 1);
        yield* t.archive(id);
        yield* t.archive(id); // idempotent by state (C6)
        const getResult = yield* t.get(id);
        const got = yield* templateView(getResult);
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
    expect(edit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition" })),
    );
    expect(use.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition" })),
    );
  });
});

describe("Templates.use", () => {
  test("creates a draft or issues with template values as defaults and the patch on top", async () => {
    const exit = await scenario(member("member"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(templateInput());
        const id = (yield* templateView(saveResult)).id;
        const draft = yield* t.use(id);
        const issued = yield* t.use(id, {
          as: "issued",
          patch: { issuedOn: IsoDate.make("2026-11-20"), note: "Thanks" },
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
    const issuedRow = Option.getOrUndefined(EffectArray.findFirst(docs, (d) => d.id === issued.id));
    expect(issuedRow?.input.due).toEqual({ inDays: 14 });
    expect(issuedRow?.input.issuedOn).toBe(IsoDate.make("2026-11-20"));
    expect(issuedRow?.input.note).toBe("Thanks");
    expect(issuedRow?.input).not.toHaveProperty("name");
    expect(issuedRow?.actor).toBe("Member");
    expect(Exit.isFailure(numberPatch)).toBe(true);
  });
});
