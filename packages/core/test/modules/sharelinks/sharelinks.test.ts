/** PublicShareLinks (core-ports 4.6) through the service on real layers. */
import { describe, expect, test } from "bun:test";
import type { Caller, DocumentId, ShareToken, UserId } from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  NotFound,
  PublicShareLinks,
  Unavailable,
} from "@kvitbit/domain/contract";
import type { Layer } from "effect";
import { Effect, Exit, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { NumberingSeries } from "../../../src/modules/numbering";
import {
  deriveToken,
  ShareFixtures,
  ShareLinkKeys,
  ShareLinksRepo,
  ShareLinksTestLayer,
  ShareVisitorDevice,
  shareLinkKeysTest,
} from "../../../src/modules/sharelinks";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, shareVisitor, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import type { Services } from "../documents/fixtures";
import { as, invoiceInput, scenario, str } from "../documents/fixtures";

const WS = WORKSPACE_A;
const OTHER_USER = "01900000-0000-7000-8000-00000000c009" as UserId;
const tokenNotFound = new NotFound({ entity: "ShareLink", id: "token" });

/** Exits are compared loosely: the domain signatures omit Forbidden/Unavailable (service.ts). */
const fails = (exit: Exit.Exit<unknown, unknown> | undefined, error: unknown) =>
  expect(exit).toEqual(Exit.fail(error));

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

type ShareServices = Services | Layer.Success<typeof ShareLinksTestLayer>;

const setup = Effect.flatMap(CoreStore, (store) =>
  store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      n.ensureDefaults(WS, ["invoice", "proforma", "credit_note"]),
    ),
  ),
);

/** Runs `body` as `caller` (default owner) over ShareLinksTestLayer + DocumentsTestLayer. */
const run = <A, E>(
  body: Effect.Effect<A, E, ShareServices>,
  options: { readonly caller?: Caller } = {},
) =>
  scenario(Effect.andThen(setup, body).pipe(Effect.provide(ShareLinksTestLayer)), {
    // Every kind gets its Workspace default series (as in the documents lifecycle tests).
    billingA: { seriesByKind: {} },
    ...(options.caller === undefined ? {} : { caller: options.caller }),
  });

const issueInvoice = Effect.flatMap(Documents, (d) => d.issue({ input: invoiceInput() }));
/** A Proforma is never a tax document, so `cancel` cancels it (no Credit Note, D6). */
const issueProforma = Effect.flatMap(Documents, (d) =>
  d.issue({ input: invoiceInput({ kind: "proforma" }) }),
);
const share = (id: DocumentId) => Effect.flatMap(PublicShareLinks, (s) => s.create(id));
const tokenOf = (url: string) => url.slice("https://share.test/s/".length) as ShareToken;
const visit = <A, E, R>(token: ShareToken, effect: Effect.Effect<A, E, R>, user?: UserId) =>
  as(shareVisitor({ token, ...(user === undefined ? {} : { signedInUser: user }) }), effect);
const open = Effect.flatMap(PublicShareLinks, (s) => s.open);
const views = (id: DocumentId, page?: { cursor?: string; limit?: number }) =>
  Effect.flatMap(PublicShareLinks, (s) => s.views(id, page));
const historyActions = (id: DocumentId) =>
  Effect.map(
    Effect.flatMap(Documents, (d) => d.history(id)),
    (entries) => entries.map((e) => e.action),
  );

/** An issued invoice and its share URL, as the owner. */
const shared = Effect.gen(function* () {
  const doc = yield* issueInvoice;
  const { url } = yield* share(doc.id);
  return { doc, url, token: tokenOf(url) };
});

describe("create", () => {
  test("returns a v1 HMAC token URL; a repeat returns the same URL and audits once", async () => {
    const [first, second, actions] = ok(
      await run(
        Effect.gen(function* () {
          const doc = yield* issueInvoice;
          const first = yield* share(doc.id);
          const second = yield* share(doc.id);
          return [first, second, yield* historyActions(doc.id)] as const;
        }),
      ),
    );
    expect(first.url).toMatch(/^https:\/\/share\.test\/s\/v1\.[A-Za-z0-9_-]{43}$/);
    expect(second.url).toBe(first.url);
    expect(actions.filter((a) => a === "share.create")).toHaveLength(1);
  });

  test("the token is re-derived from the link id; only its hash is stored", async () => {
    const [token, link] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const link = yield* (yield* ShareLinksRepo).activeFor(WS, doc.id);
          return [token, Option.getOrThrow(link)] as const;
        }),
      ),
    );
    const derived = await Effect.runPromise(
      deriveToken(link.id, 1, new TextEncoder().encode("test-share-key-v1")),
    );
    expect(derived).toBe(token);
    expect(JSON.stringify(link)).not.toContain(token.slice(3));
    expect(link.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each(["owner", "admin", "member"] as const)("%s may create", async (role) => {
    const exit = await run(Effect.flatMap(issueInvoice, (doc) => as(member(role), share(doc.id))));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("accountant, a documents-only token, System and a visitor are Forbidden", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const doc = yield* issueInvoice;
          const attempt = (caller: Caller) => Effect.exit(as(caller, share(doc.id)));
          return [
            yield* attempt(member("accountant")),
            yield* attempt(member("owner", { scopes: ["documents:write"] })),
            yield* attempt(system()),
            yield* attempt(shareVisitor()),
          ];
        }),
      ),
    );
    for (const exit of results) {
      fails(exit, new Forbidden({ action: "share.write" }));
    }
  });

  test("another Workspace's document is NotFound", async () => {
    const exit = await run(
      Effect.flatMap(issueInvoice, (doc) =>
        as(member("owner", { workspaceId: WORKSPACE_B }), share(doc.id)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    fails(exit, expect.any(NotFound) as never);
  });

  test("a draft or a cancelled document cannot be shared (illegal_transition)", async () => {
    const [draft, cancelled] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const draft = yield* d.createDraft(invoiceInput());
          const issued = yield* issueProforma;
          yield* d.cancel(issued.id, { reason: "chyba" });
          return [
            yield* Effect.exit(share(draft.id)),
            yield* Effect.exit(share(issued.id)),
          ] as const;
        }),
      ),
    );
    fails(draft, new Conflict({ reason: "illegal_transition" }));
    fails(cancelled, new Conflict({ reason: "illegal_transition" }));
  });

  test("rotating the key version expires old links; create replaces the link once", async () => {
    const r = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const repo = yield* ShareLinksRepo;
          const before = Option.getOrThrow(yield* repo.activeFor(WS, doc.id));
          // Every later call runs under key version 2 (the call site's context wins).
          return yield* Effect.gen(function* () {
            const oldOpen = yield* Effect.exit(visit(token, open));
            const first = tokenOf((yield* share(doc.id)).url);
            const repeat = tokenOf((yield* share(doc.id)).url);
            const after = Option.getOrThrow(yield* repo.activeFor(WS, doc.id));
            return {
              before,
              after,
              first,
              repeat,
              oldOpen,
              oldAgain: yield* Effect.exit(visit(token, open)),
              fresh: yield* visit(first, open),
              history: yield* Effect.flatMap(Documents, (d) => d.history(doc.id)),
            };
          }).pipe(Effect.provideService(ShareLinkKeys, shareLinkKeysTest(2)));
        }),
      ),
    );
    fails(r.oldOpen, tokenNotFound);
    fails(r.oldAgain, tokenNotFound);
    expect(r.first).toMatch(/^v2\./);
    expect(r.repeat).toBe(r.first);
    expect(r.after.id).not.toBe(r.before.id);
    expect(r.after.keyVersion).toBe(2);
    expect(r.fresh.number).toBe("2026-0001");
    const creates = r.history.filter((e) => e.action === "share.create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.changes).toEqual([
      { path: "share", before: r.before.id, after: r.after.id },
    ]);
  });
});

describe("revoke", () => {
  test("the token then returns NotFound; revoke repeats; create makes a new token", async () => {
    const [revokedOpen, again, fresh, oldOpen, freshOpen, actions] = ok(
      await run(
        Effect.gen(function* () {
          const s = yield* PublicShareLinks;
          const { doc, token } = yield* shared;
          yield* s.revoke(doc.id);
          const revokedOpen = yield* Effect.exit(visit(token, open));
          const again = yield* Effect.exit(s.revoke(doc.id));
          const fresh = tokenOf((yield* s.create(doc.id)).url);
          return [
            revokedOpen,
            again,
            fresh === token,
            yield* Effect.exit(visit(token, open)),
            yield* Effect.exit(visit(fresh, open)),
            yield* historyActions(doc.id),
          ] as const;
        }),
      ),
    );
    fails(revokedOpen, tokenNotFound);
    expect(Exit.isSuccess(again)).toBe(true);
    expect(fresh).toBe(false);
    fails(oldOpen, tokenNotFound);
    expect(Exit.isSuccess(freshOpen)).toBe(true);
    expect(actions.filter((a) => a.startsWith("share."))).toEqual([
      "share.create",
      "share.revoke",
      "share.create",
    ]);
  });

  test("accountant is Forbidden; another Workspace's document is NotFound", async () => {
    const [accountant, foreign] = ok(
      await run(
        Effect.gen(function* () {
          const { doc } = yield* shared;
          const revoke = Effect.flatMap(PublicShareLinks, (s) => s.revoke(doc.id));
          return [
            yield* Effect.exit(as(member("accountant"), revoke)),
            yield* Effect.exit(as(member("owner", { workspaceId: WORKSPACE_B }), revoke)),
          ] as const;
        }),
      ),
    );
    fails(accountant, new Forbidden({ action: "share.write" }));
    fails(foreign, expect.any(NotFound) as never);
  });
});

describe("open", () => {
  test("returns the narrowed recipient view and records one view per visitor per hour", async () => {
    const [view, firstPage, link] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const view = yield* visit(token, open).pipe(
            Effect.provideService(ShareVisitorDevice, "mobile"),
          );
          yield* visit(token, open); // same visitor within the hour: deduplicated
          yield* TestClock.adjust("61 minutes");
          yield* visit(token, open);
          const link = Option.getOrThrow(yield* (yield* ShareLinksRepo).activeFor(WS, doc.id));
          return [view, yield* views(doc.id), link] as const;
        }),
      ),
    );
    expect(view.number).toBe("2026-0001");
    expect(view.status).toBe("issued");
    expect(view.viewerIsIssuer).toBe(false);
    expect(view.pdfUrl).toMatch(/\/pdf$/);
    expect(view.language).toBe("cs");
    expect(str(view.amountDue.amount)).toBe(str(view.totals.gross.amount));
    expect(view.branding.pdfTemplate).toBe("classic");
    expect(Object.keys(view)).not.toContain("deliveries");
    expect(firstPage.items.map((e) => e.kind)).toEqual(["view", "view"]);
    expect(firstPage.items.map((e) => e.device)).toEqual(["unknown", "mobile"]);
    expect(firstPage.items[0]?.at).toBe("2026-11-23T10:01:00.000Z");
    // The first view set viewedAt; later views did not move it.
    expect(link.viewedAt).toBe("2026-11-23T09:00:00.000Z");
  });

  test("concurrent opens by one visitor record one view", async () => {
    const page = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          yield* Effect.all(
            Array.from({ length: 5 }, () => visit(token, open)),
            {
              concurrency: "unbounded",
            },
          );
          return yield* views(doc.id);
        }),
      ),
    );
    expect(page.items).toHaveLength(1);
  });

  test("a different visitor hash counts as a new view", async () => {
    const page = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          yield* visit(token, open);
          yield* as({ ...shareVisitor({ token }), visitor: "other-visitor" as never }, open);
          return yield* views(doc.id);
        }),
      ),
    );
    expect(page.items).toHaveLength(2);
  });

  test("unknown, malformed and retired-version tokens are the same NotFound", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          yield* shared;
          const fake = `v1.${"A".repeat(43)}` as ShareToken;
          const retired = `v0.${"A".repeat(43)}` as ShareToken;
          return [
            yield* Effect.exit(visit(fake, open)),
            yield* Effect.exit(visit("garbage" as ShareToken, open)),
            yield* Effect.exit(visit(retired, open)),
          ];
        }),
      ),
    );
    for (const exit of results) fails(exit, tokenNotFound);
  });

  test("a visitor sees only its own token's document", async () => {
    const [a, b] = ok(
      await run(
        Effect.gen(function* () {
          const first = yield* shared;
          const second = yield* shared;
          return [yield* visit(first.token, open), yield* visit(second.token, open)] as const;
        }),
      ),
    );
    expect(a.number).toBe("2026-0001");
    expect(b.number).toBe("2026-0002");
  });

  test("Members are Forbidden from the visitor methods", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          yield* shared;
          const s = yield* PublicShareLinks;
          return [
            yield* Effect.exit(s.open),
            yield* Effect.exit(s.pdf()),
            yield* Effect.exit(s.logo),
          ];
        }),
      ),
    );
    fails(results[0], new Forbidden({ action: "share.open" }));
    fails(results[1], new Forbidden({ action: "share.pdf" }));
    fails(results[2], new Forbidden({ action: "share.logo" }));
  });

  test("a signed-in Member of the issuer records nothing and gets viewerIsIssuer", async () => {
    const [issuerView, outsiderView, page] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const fixtures = yield* ShareFixtures;
          yield* fixtures.addMember(WS, member("owner").userId);
          const issuerView = yield* visit(token, open, member("owner").userId);
          yield* visit(
            token,
            Effect.flatMap(PublicShareLinks, (s) => s.pdf()),
            member("owner").userId,
          );
          const outsiderView = yield* visit(token, open, OTHER_USER);
          return [issuerView, outsiderView, yield* views(doc.id)] as const;
        }),
      ),
    );
    expect(issuerView.viewerIsIssuer).toBe(true);
    expect(outsiderView.viewerIsIssuer).toBe(false);
    expect(page.items).toHaveLength(1);
  });

  test("a cancelled document stays viewable and shows its state", async () => {
    const view = ok(
      await run(
        Effect.gen(function* () {
          const doc = yield* issueProforma;
          const token = tokenOf((yield* share(doc.id)).url);
          yield* (yield* Documents).cancel(doc.id, { reason: "chyba" });
          return yield* visit(token, open);
        }),
      ),
    );
    expect(view.status).toBe("cancelled");
    expect(str(view.amountDue.amount)).toBe("0");
  });
});

describe("credited documents", () => {
  test("a storno-credited invoice stays viewable with nothing due; its Credit Note shows the original number", async () => {
    const [invoiceView, creditView] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const { creditNote } = yield* (yield* Documents).cancel(doc.id, { reason: "chyba" });
          if (creditNote === null) return yield* Effect.die("expected a Credit Note");
          const creditToken = tokenOf((yield* share(creditNote.id)).url);
          return [yield* visit(token, open), yield* visit(creditToken, open)] as const;
        }),
      ),
    );
    expect(invoiceView.status).toBe("issued");
    expect(invoiceView.settlement).toBe("credited");
    expect(str(invoiceView.amountDue.amount)).toBe("0");
    expect(creditView.kind).toBe("credit_note");
    expect(creditView.correctsNumber).toBe("2026-0001");
  });
});

describe("pdf and logo", () => {
  test("pdf renders the document and records a download (not deduplicated)", async () => {
    const [file, bytes, page] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const pdf = Effect.flatMap(PublicShareLinks, (s) => s.pdf({ language: "en" }));
          const file = yield* visit(token, pdf);
          yield* visit(token, pdf);
          const bytes = yield* Stream.runCollect(file.bytes);
          return [file, bytes, yield* views(doc.id)] as const;
        }),
      ),
    );
    expect(file.contentType).toBe("application/pdf");
    expect(file.filename).toBe("2026-0001.pdf");
    expect(bytes.length).toBeGreaterThan(0);
    expect(page.items.map((e) => e.kind)).toEqual(["download", "download"]);
  });

  test("a pdf that fails before rendering records no download", async () => {
    const [exit, page] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          yield* Ref.set((yield* ShareFixtures).unavailable, true);
          const exit = yield* Effect.exit(
            visit(
              token,
              Effect.flatMap(PublicShareLinks, (s) => s.pdf()),
            ),
          );
          yield* Ref.set((yield* ShareFixtures).unavailable, false);
          return [exit, yield* views(doc.id)] as const;
        }),
      ),
    );
    fails(exit, new Unavailable({ dependency: "database" }));
    expect(page.items).toHaveLength(0);
  });

  test("logo is NotFound without one and the Workspace logo with one; revoked tokens fail", async () => {
    const [missing, found, revoked] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const logo = Effect.flatMap(PublicShareLinks, (s) => s.logo);
          const missing = yield* Effect.exit(visit(token, logo));
          yield* (yield* ShareFixtures).setLogo(WS, {
            contentType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          });
          const found = yield* visit(token, logo);
          yield* (yield* PublicShareLinks).revoke(doc.id);
          return [missing, found, yield* Effect.exit(visit(token, logo))] as const;
        }),
      ),
    );
    fails(missing, new NotFound({ entity: "ShareLink", id: "logo" }));
    expect(found.contentType).toBe("image/png");
    fails(revoked, tokenNotFound);
  });
});

describe("views", () => {
  test("pages newest first with a cursor bound to the document", async () => {
    const [first, second, foreignCursor, badLimit] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const other = yield* shared;
          yield* visit(token, open);
          yield* TestClock.adjust("2 hours");
          yield* visit(token, open);
          const first = yield* views(doc.id, { limit: 1 });
          const second = yield* views(doc.id, { limit: 1, cursor: first.nextCursor ?? "" });
          return [
            first,
            second,
            yield* Effect.exit(views(other.doc.id, { cursor: first.nextCursor ?? "" })),
            yield* Effect.exit(views(doc.id, { limit: 0 })),
          ] as const;
        }),
      ),
    );
    expect(first.items[0]?.at).toBe("2026-11-23T11:00:00.000Z");
    expect(first.nextCursor).not.toBeNull();
    expect(second.items[0]?.at).toBe("2026-11-23T09:00:00.000Z");
    expect(second.nextCursor).toBeNull();
    fails(
      foreignCursor,
      new Invalid({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] }),
    );
    fails(badLimit, new Invalid({ issues: [{ path: ["limit"], code: "request.malformed" }] }));
  });

  test("every Member role may read; a documents-only token is Forbidden; foreign is NotFound", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const { doc } = yield* shared;
          const read = (caller: Caller) => Effect.exit(as(caller, views(doc.id)));
          return [
            yield* read(member("accountant")),
            yield* read(member("member", { scopes: ["share:read"] })),
            yield* read(member("owner", { scopes: ["documents:read"] })),
            yield* read(member("owner", { workspaceId: WORKSPACE_B })),
          ];
        }),
      ),
    );
    expect(Exit.isSuccess(results[0] as Exit.Exit<unknown, unknown>)).toBe(true);
    expect(Exit.isSuccess(results[1] as Exit.Exit<unknown, unknown>)).toBe(true);
    fails(results[2], new Forbidden({ action: "share.read" }));
    fails(results[3], expect.any(NotFound) as never);
  });
});
