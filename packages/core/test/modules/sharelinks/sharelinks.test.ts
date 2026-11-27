import { withoutStackTrace } from "../../helpers/run";
/** PublicShareLinks (core-ports 4.6) through the service on real layers. */

import { describe, expect, test } from "bun:test";
import type { Caller, DocumentId } from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  NotFound,
  PublicShareLinks,
  ShareToken,
  Unavailable,
  UserId,
  VisitorHash,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { NumberingSeries } from "../../../src/modules/numbering";
import {
  deriveToken,
  ShareFixtures,
  ShareLinkKeys,
  ShareLinksRepo,
  ShareLinksTestLayer,
  ShareVisitorDevice,
  shareLinkKeysTest,
  tokenVersion,
} from "../../../src/modules/sharelinks";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, shareVisitor, system, WORKSPACE_B, WORKSPACE_A as WS } from "../../helpers";
import type { Services } from "../documents/fixtures";
import { as, invoiceInput, scenario, str } from "../documents/fixtures";

const V1_SHARE_URL = /^https:\/\/share\.test\/s\/v1\.[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const V2_TOKEN = /^v2\./;
const PDF_PATH = /\/pdf$/;
const OTHER_USER = UserId.make("01900000-0000-7000-8000-00000000c009");
const tokenNotFound = NotFound.make({ entity: "ShareLink", id: "token" });

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
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
    caller: options.caller ?? member("owner"),
  });

const issueInvoice = Effect.flatMap(Documents, (d) => d.issue({ input: invoiceInput() }));
/** A Proforma is never a tax document, so `cancel` cancels it (no Credit Note, D6). */
const issueProforma = Effect.flatMap(Documents, (d) =>
  d.issue({ input: invoiceInput({ kind: "proforma" }) }),
);
const share = (id: DocumentId) => Effect.flatMap(PublicShareLinks, (s) => s.create(id));
const tokenOf = (url: string) =>
  ShareToken.make(EffectString.slice("https://share.test/s/".length)(url));
const visit = <A, E, R>(token: ShareToken, effect: Effect.Effect<A, E, R>, user?: UserId) =>
  as(shareVisitor(user === undefined ? { token } : { token, signedInUser: user }), effect);
const open = Effect.flatMap(PublicShareLinks, (s) => s.open);
const views = (id: DocumentId, page?: { cursor?: string; limit?: number }) =>
  Effect.flatMap(PublicShareLinks, (s) => s.views(id, page));
const historyActions = (id: DocumentId) =>
  Effect.map(
    Effect.flatMap(Documents, (d) => d.history(id)),
    (entries) => EffectArray.map(entries, (e) => e.action),
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
          const firstResult = yield* share(doc.id);
          const secondResult = yield* share(doc.id);
          return [firstResult, secondResult, yield* historyActions(doc.id)] as const;
        }),
      ),
    );
    expect(first.url).toMatch(V1_SHARE_URL);
    expect(second.url).toBe(first.url);
    expect(EffectArray.filter(actions, (a) => a === "share.create")).toHaveLength(1);
  });

  test("the token is re-derived from the link id; only its hash is stored", async () => {
    const [token, link] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token: tokenResult } = yield* shared;
          const linkResult = yield* (yield* ShareLinksRepo).activeFor(WS, doc.id);
          return [tokenResult, Option.getOrThrow(linkResult)] as const;
        }),
      ),
    );
    const derived = await Effect.runPromise(
      deriveToken(link.id, 1, new TextEncoder().encode("test-share-key-v1")),
    );
    expect(derived).toBe(token);
    const encoded = await Effect.runPromise(
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(link),
    );
    expect(encoded).not.toContain(EffectString.slice(3)(token));
    expect(link.tokenHash).toMatch(TOKEN_HASH);
  });

  test("token derivation matches an independent HMAC-SHA256 vector (openssl)", async () => {
    // printf '%s' <id> | openssl dgst -sha256 -hmac test-share-key-v1 -binary | base64url
    const token = await Effect.runPromise(
      deriveToken(
        "01900000-0000-7000-8000-000000000001",
        1,
        new TextEncoder().encode("test-share-key-v1"),
      ),
    );
    expect(String(token)).toBe("v1.jkBaEUzhzzYmP6ghkkLPXhDTxy4BILC_6W7A8RaHhDo");
  });

  test("token versions are non-negative int4 values", () => {
    const mac = EffectString.repeat(43)("A");
    expect(tokenVersion(`v0.${mac}`)).toBe(0);
    expect(tokenVersion(`v2147483647.${mac}`)).toBe(2_147_483_647);
    expect(tokenVersion(`v2147483648.${mac}`)).toBeNull();
    expect(tokenVersion(`v01.${mac}`)).toBeNull();
    expect(tokenVersion(`v1.${mac}=`)).toBeNull();
  });

  test("a URL created under a large key version opens (generation and parsing agree)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const doc = yield* issueInvoice;
        const token = tokenOf((yield* share(doc.id)).url);
        return yield* visit(token, open);
      }).pipe(Effect.provideService(ShareLinkKeys, shareLinkKeysTest(2_147_483_647))),
    );
    expect(ok(exit).number).toBe("2026-0001");
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
      expect(exit.pipe(withoutStackTrace)).toEqual(
        Exit.fail(Forbidden.make({ action: "share.write" })),
      );
    }
  });

  test("another Workspace's document is NotFound", async () => {
    const exit = await run(
      Effect.flatMap(issueInvoice, (doc) =>
        as(member("owner", { workspaceId: WORKSPACE_B }), share(doc.id)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(exit.pipe(withoutStackTrace)).toEqual(Exit.fail(expect.any(NotFound)));
  });

  test("a draft or a cancelled document cannot be shared (illegal_transition)", async () => {
    const [draft, cancelled] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const draftResult = yield* d.createDraft(invoiceInput());
          const issued = yield* issueProforma;
          yield* d.cancel(issued.id, { reason: "chyba" });
          return [
            yield* Effect.exit(share(draftResult.id)),
            yield* Effect.exit(share(issued.id)),
          ] as const;
        }),
      ),
    );
    expect(draft.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition" })),
    );
    expect(cancelled.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition" })),
    );
  });

  test("rotating the key version expires old links; create replaces the link once", async () => {
    const r = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const repo = yield* ShareLinksRepo;
          const activeForResult = yield* repo.activeFor(WS, doc.id);
          const before = Option.getOrThrow(activeForResult);
          // Every later call runs under key version 2 (the call site's context wins).
          return yield* Effect.gen(function* () {
            const oldOpen = yield* Effect.exit(visit(token, open));
            const first = tokenOf((yield* share(doc.id)).url);
            const repeat = tokenOf((yield* share(doc.id)).url);
            const activeForResultResult = yield* repo.activeFor(WS, doc.id);
            const after = Option.getOrThrow(activeForResultResult);
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
    expect(r.oldOpen.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
    expect(r.oldAgain.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
    expect(r.first).toMatch(V2_TOKEN);
    expect(r.repeat).toBe(r.first);
    expect(r.after.id).not.toBe(r.before.id);
    expect(r.after.keyVersion).toBe(2);
    expect(r.fresh.number).toBe("2026-0001");
    const creates = EffectArray.filter(r.history, (e) => e.action === "share.create");
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
          const revokedOpenResult = yield* Effect.exit(visit(token, open));
          const againResult = yield* Effect.exit(s.revoke(doc.id));
          const freshResult = tokenOf((yield* s.create(doc.id)).url);
          return [
            revokedOpenResult,
            againResult,
            freshResult === token,
            yield* Effect.exit(visit(token, open)),
            yield* Effect.exit(visit(freshResult, open)),
            yield* historyActions(doc.id),
          ] as const;
        }),
      ),
    );
    expect(revokedOpen.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
    expect(Exit.isSuccess(again)).toBe(true);
    expect(fresh).toBe(false);
    expect(oldOpen.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
    expect(Exit.isSuccess(freshOpen)).toBe(true);
    expect(EffectArray.filter(actions, (a) => EffectString.startsWith("share.")(a))).toEqual([
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
    expect(accountant.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "share.write" })),
    );
    expect(foreign.pipe(withoutStackTrace)).toEqual(Exit.fail(expect.any(NotFound)));
  });
});

describe("open", () => {
  test("returns the narrowed recipient view and records one view per visitor per hour", async () => {
    const [view, firstPage, link] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const viewResult = yield* visit(token, open).pipe(
            Effect.provideService(ShareVisitorDevice, "mobile"),
          );
          yield* visit(token, open); // same visitor within the hour: deduplicated
          yield* TestClock.adjust("61 minutes");
          yield* visit(token, open);
          const activeForResult = yield* (yield* ShareLinksRepo).activeFor(WS, doc.id);
          const linkResult = Option.getOrThrow(activeForResult);
          return [viewResult, yield* views(doc.id), linkResult] as const;
        }),
      ),
    );
    expect(view.number).toBe("2026-0001");
    expect(view.status).toBe("issued");
    expect(view.viewerIsIssuer).toBe(false);
    expect(view.pdfUrl).toMatch(PDF_PATH);
    expect(view.language).toBe("cs");
    view.amountDue.amount.pipe(str, expect).toBe(str(view.totals.gross.amount));
    expect(view.branding.pdfTemplate).toBe("classic");
    expect(EffectRecord.keys(view)).not.toContain("deliveries");
    expect(EffectArray.map(firstPage.items, (e) => e.kind)).toEqual(["view", "view"]);
    expect(EffectArray.map(firstPage.items, (e) => e.device)).toEqual(["unknown", "mobile"]);
    expect(firstPage.items[0]?.at).toBe("2026-11-23T10:01:00.000Z");
    // The first view set viewedAt; later views did not move it.
    expect(link.viewedAt).toBe("2026-11-23T09:00:00.000Z");
  });

  test("the dedup window is one hour, exclusive: just before counts once, exactly at counts twice", async () => {
    const page = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          yield* visit(token, open); // 09:00:00.000
          yield* TestClock.adjust("3599999 millis");
          yield* visit(token, open); // 09:59:59.999: same hour, deduplicated
          yield* TestClock.adjust("1 millis");
          yield* visit(token, open); // 10:00:00.000: a new view
          return yield* views(doc.id);
        }),
      ),
    );
    expect(EffectArray.map(page.items, (e) => e.at)).toEqual([
      "2026-11-23T10:00:00.000Z",
      "2026-11-23T09:00:00.000Z",
    ]);
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
          yield* as(
            { ...shareVisitor({ token }), visitor: VisitorHash.make("other-visitor") },
            open,
          );
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
          const fake = ShareToken.make(`v1.${EffectString.repeat(43)("A")}`);
          const retired = ShareToken.make(`v0.${EffectString.repeat(43)("A")}`);
          return [
            yield* Effect.exit(visit(fake, open)),
            yield* Effect.exit(visit(ShareToken.make("garbage"), open)),
            yield* Effect.exit(visit(retired, open)),
          ];
        }),
      ),
    );
    for (const exit of results)
      expect(exit.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
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
          ] as const;
        }),
      ),
    );
    expect(results[0].pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "share.open" })),
    );
    expect(results[1].pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "share.pdf" })),
    );
    expect(results[2].pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "share.logo" })),
    );
  });

  test("a signed-in Member of the issuer records nothing and gets viewerIsIssuer", async () => {
    const [issuerView, outsiderView, page] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const fixtures = yield* ShareFixtures;
          yield* fixtures.addMember(WS, member("owner").userId);
          const issuerViewResult = yield* visit(token, open, member("owner").userId);
          yield* visit(
            token,
            Effect.flatMap(PublicShareLinks, (s) => s.pdf()),
            member("owner").userId,
          );
          const outsiderViewResult = yield* visit(token, open, OTHER_USER);
          return [issuerViewResult, outsiderViewResult, yield* views(doc.id)] as const;
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
    view.amountDue.amount.pipe(str, expect).toBe("0");
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
    invoiceView.amountDue.amount.pipe(str, expect).toBe("0");
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
          const fileResult = yield* visit(token, pdf);
          yield* visit(token, pdf);
          const bytesResult = yield* Stream.runCollect(fileResult.bytes);
          return [fileResult, bytesResult, yield* views(doc.id)] as const;
        }),
      ),
    );
    expect(file.contentType).toBe("application/pdf");
    expect(file.filename).toBe("2026-0001.pdf");
    expect(bytes.length).toBeGreaterThan(0);
    expect(EffectArray.map(page.items, (e) => e.kind)).toEqual(["download", "download"]);
  });

  test("a pdf that fails before rendering records no download", async () => {
    const [exit, page] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          yield* Ref.set((yield* ShareFixtures).unavailable, true);
          const exitResult = yield* Effect.exit(
            visit(
              token,
              Effect.flatMap(PublicShareLinks, (s) => s.pdf()),
            ),
          );
          yield* Ref.set((yield* ShareFixtures).unavailable, false);
          return [exitResult, yield* views(doc.id)] as const;
        }),
      ),
    );
    expect(exit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "database" })),
    );
    expect(page.items).toHaveLength(0);
  });

  test("logo is NotFound without one and the Workspace logo with one; revoked tokens fail", async () => {
    const [missing, found, revoked] = ok(
      await run(
        Effect.gen(function* () {
          const { doc, token } = yield* shared;
          const logo = Effect.flatMap(PublicShareLinks, (s) => s.logo);
          const missingResult = yield* Effect.exit(visit(token, logo));
          yield* (yield* ShareFixtures).setLogo(WS, {
            contentType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          });
          const foundResult = yield* visit(token, logo);
          yield* (yield* PublicShareLinks).revoke(doc.id);
          return [missingResult, foundResult, yield* Effect.exit(visit(token, logo))] as const;
        }),
      ),
    );
    expect(missing.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "ShareLink", id: "logo" })),
    );
    expect(found.contentType).toBe("image/png");
    expect(revoked.pipe(withoutStackTrace)).toEqual(Exit.fail(tokenNotFound));
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
          const firstResult = yield* views(doc.id, { limit: 1 });
          const secondResult = yield* views(doc.id, {
            limit: 1,
            cursor: firstResult.nextCursor ?? "",
          });
          return [
            firstResult,
            secondResult,
            yield* Effect.exit(views(other.doc.id, { cursor: firstResult.nextCursor ?? "" })),
            yield* Effect.exit(views(doc.id, { limit: 0 })),
          ] as const;
        }),
      ),
    );
    expect(first.items[0]?.at).toBe("2026-11-23T11:00:00.000Z");
    expect(first.nextCursor).not.toBeNull();
    expect(second.items[0]?.at).toBe("2026-11-23T09:00:00.000Z");
    expect(second.nextCursor).toBeNull();
    expect(foreignCursor.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Invalid.make({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] })),
    );
    expect(badLimit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Invalid.make({ issues: [{ path: ["limit"], code: "request.malformed" }] })),
    );
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
          ] as const;
        }),
      ),
    );
    expect(Exit.isSuccess(results[0])).toBe(true);
    expect(Exit.isSuccess(results[1])).toBe(true);
    expect(results[2].pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "share.read" })),
    );
    expect(results[3].pipe(withoutStackTrace)).toEqual(Exit.fail(expect.any(NotFound)));
  });
});
