/**
 * Visitor side of Public Share Links (core-ports 4.6): `open`, `pdf`, `logo` for the
 * `ShareLinkVisitor` caller, on its own token only. Unknown, malformed, revoked and expired
 * (retired key version) tokens are one indistinguishable `NotFound{ShareLink}`, so the page
 * cannot probe tokens. A signed-in Member of the issuing Workspace records nothing.
 */
import type {
  FileDownload,
  Locale,
  SharedDocumentView,
  ShareLinkVisitorCaller,
} from "@kvitbit/domain/contract";
import { Forbidden, NotFound } from "@kvitbit/domain/contract";
import { Effect, Option, Stream } from "effect";
import { authorize } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import type { DeliveryDocument } from "../documents";
import { DocumentDeliveryReads, DocumentsRepo, outstandingOf } from "../documents";
import { nowIso } from "./members";
import { ShareLinkKeys, ShareVisitorDevice, ShareWorkspaces } from "./ports";
import type { ShareLinkRecord, ShareViewRecord } from "./record";
import { ShareLinksRepo } from "./repo";
import { tokenVersion } from "./token";

/** Views by the same visitor within this window count once. */
export const VIEW_DEDUP_MILLIS = 60 * 60 * 1000;

/** The token is not echoed (it would reach logs); every miss looks the same. */
const unknownToken = (_token: string) => new NotFound({ entity: "ShareLink", id: "token" });

/** Authorizes `action` and resolves the caller's own token to its active link. */
const resolve = (action: "share.open" | "share.pdf" | "share.logo") =>
  Effect.gen(function* () {
    const caller = yield* authorize(action);
    if (caller._tag !== "ShareLinkVisitor") return yield* new Forbidden({ action });
    const version = tokenVersion(caller.token);
    const keys = yield* ShareLinkKeys;
    if (version === null || keys.secret(version) === null) {
      return yield* unknownToken(caller.token);
    }
    const found = yield* (yield* ShareLinksRepo).byTokenHash(yield* sha256Hex(caller.token));
    if (
      Option.isNone(found) ||
      found.value.revokedAt !== null ||
      found.value.keyVersion !== version
    ) {
      return yield* unknownToken(caller.token);
    }
    return { caller, link: found.value };
  });

/** The shared document; a document the link no longer reaches is the same `NotFound`. */
const loadDocument = (caller: ShareLinkVisitorCaller, link: ShareLinkRecord, language?: Locale) =>
  Effect.flatMap(DocumentDeliveryReads, (reads) =>
    reads.load(link.workspaceId, link.documentId, language === undefined ? {} : { language }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.fail(unknownToken(caller.token))));

const isIssuer = (caller: ShareLinkVisitorCaller, link: ShareLinkRecord) => {
  const user = caller.signedInUser;
  return user === undefined
    ? Effect.succeed(false)
    : Effect.flatMap(ShareWorkspaces, (w) => w.isMember(link.workspaceId, user));
};

const event = (
  caller: ShareLinkVisitorCaller,
  link: ShareLinkRecord,
  kind: ShareViewRecord["kind"],
  at: string,
) =>
  Effect.gen(function* () {
    return {
      id: yield* newId<ShareViewRecord["id"]>(),
      workspaceId: link.workspaceId,
      revision: 1,
      shareLinkId: link.id,
      documentId: link.documentId,
      kind,
      device: yield* ShareVisitorDevice,
      visitorHash: caller.visitor,
      at,
    } satisfies ShareViewRecord;
  });

/** A view, deduplicated per visitor per hour; the first view sets the link's `viewedAt`. */
const recordView = (caller: ShareLinkVisitorCaller, link: ShareLinkRecord) =>
  Effect.gen(function* () {
    const repo = yield* ShareLinksRepo;
    const at = yield* nowIso;
    const since = new Date(Date.parse(at) - VIEW_DEDUP_MILLIS).toISOString();
    if (yield* repo.hasEventSince(link.workspaceId, link.id, caller.visitor, "view", since)) return;
    yield* repo.recordEvent(yield* event(caller, link, "view", at));
    if (link.viewedAt !== null) return;
    const locked = yield* repo.lock(link.workspaceId, link.id);
    if (locked.viewedAt !== null) return;
    yield* repo
      .update({ ...locked, viewedAt: at }, locked.revision)
      .pipe(Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }));
  });

/** The last edit after issue (`document.edit` audit entries), for "Updated on D". */
const lastEditAt = (document: DeliveryDocument) =>
  Effect.map(
    Effect.flatMap(CoreStore, (store) =>
      store.audit.history(document.record.workspaceId, {
        entity: "Document",
        id: document.record.id,
      }),
    ),
    (entries) => entries.findLast((e) => e.action === "document.edit")?.at ?? null,
  );

const sharedView = (
  document: DeliveryDocument,
  link: ShareLinkRecord,
  pdfUrl: string,
  viewerIsIssuer: boolean,
) =>
  Effect.gen(function* () {
    const { record, view } = document;
    const creditNotes = yield* (yield* DocumentsRepo).getMany(
      record.workspaceId,
      record.links.filter((l) => l.relation === "corrected_by").map((l) => l.id),
    );
    const branding = yield* (yield* ShareWorkspaces).branding(link.workspaceId);
    return {
      kind: view.kind,
      number: view.number ?? "",
      status: view.status,
      settlement: view.settlement,
      taxDocument: view.taxDocument,
      dates: view.dates,
      issuer: view.issuer,
      branding,
      contact: view.contact,
      lines: view.lines,
      totals: view.totals,
      statutoryNotes: view.statutoryNotes,
      paymentQr: view.paymentQr,
      language: record.language,
      amountDue: { amount: outstandingOf(record, creditNotes), currency: record.currency },
      correctsNumber: record.correctedNumber,
      note: record.note,
      updatedAt: yield* lastEditAt(document),
      pdfUrl,
      viewerIsIssuer,
    } satisfies SharedDocumentView;
  });

/** Records a view (unless the viewer is a Member of the issuer) and returns the recipient view. */
export const open = Effect.gen(function* () {
  const store = yield* CoreStore;
  return yield* store.transaction(
    Effect.gen(function* () {
      const { caller, link } = yield* resolve("share.open");
      const document = yield* loadDocument(caller, link);
      const issuer = yield* isIssuer(caller, link);
      if (!issuer) yield* recordView(caller, link);
      return yield* sharedView(document, link, (yield* ShareLinkKeys).pdfUrl(caller.token), issuer);
    }),
  );
}).pipe(orUnavailable);

const filenameOf = (number: string | null) =>
  `${(number ?? "document").replace(/[^\p{L}\p{N}._-]+/gu, "-")}.pdf`;

/** Records a download (unless the viewer is a Member of the issuer) and renders the PDF. */
export const pdf = (opts: { readonly language?: Locale } = {}) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const { document, link } = yield* store.transaction(
      Effect.gen(function* () {
        const { caller, link } = yield* resolve("share.pdf");
        const document = yield* loadDocument(caller, link, opts.language);
        if (!(yield* isIssuer(caller, link))) {
          yield* (yield* ShareLinksRepo).recordEvent(
            yield* event(caller, link, "download", yield* nowIso),
          );
        }
        return { document, link };
      }),
    );
    const branding = yield* (yield* ShareWorkspaces).branding(link.workspaceId);
    const bytes = yield* (yield* DocumentDeliveryReads).render(document.view, {
      template: branding.pdfTemplate,
      language: opts.language ?? document.record.language,
    });
    return {
      filename: filenameOf(document.record.number),
      contentType: "application/pdf",
      bytes: Stream.make(bytes),
    } satisfies FileDownload;
  }).pipe(orUnavailable);

/** The issuing Workspace's logo; `NotFound` when it has none. Records nothing. */
export const logo = Effect.gen(function* () {
  const { link } = yield* resolve("share.logo");
  const found = yield* (yield* ShareWorkspaces).logo(link.workspaceId);
  if (Option.isNone(found)) {
    return yield* new NotFound({ entity: "ShareLink", id: "logo" });
  }
  return found.value;
}).pipe(orUnavailable);
