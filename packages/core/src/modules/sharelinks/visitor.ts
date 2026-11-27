import type {
  FileDownload,
  Locale,
  SharedDocumentView,
  ShareLinkVisitorCaller,
} from "@kvitbit/domain/contract";
import { Forbidden, NotFound, ShareViewId } from "@kvitbit/domain/contract";
/**
 * Visitor side of Public Share Links (core-ports 4.6): `open`, `pdf`, `logo` for the
 * `ShareLinkVisitor` caller, on its own token only. Unknown, malformed, revoked and expired
 * (retired key version) tokens are one indistinguishable `NotFound{ShareLink}`, so the page
 * cannot probe tokens. A signed-in Member of the issuing Workspace records nothing.
 */
import * as EffectArray from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import { authorize } from "../../policy/Policy";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import type { DeliveryDocument } from "../documents";
import { DocumentDeliveryReads, DocumentsRepo, outstandingOf } from "../documents";
import { nowIso } from "./members";
import { ShareLinkKeys, ShareVisitorDevice, ShareWorkspaces } from "./ports";
import type { ShareLink, ShareViewEventRow } from "./record";
import { ShareLinksRepo } from "./repo";
import { tokenVersion } from "./token";

/** A view counts again once this long has passed since the visitor's last counted view. */
export const VIEW_DEDUP_MILLIS = 60 * 60 * 1000;

/** The token is not echoed (it would reach logs); every miss looks the same. */
const unknownToken = NotFound.make({ entity: "ShareLink", id: "token" });

/**
 * Rule R1a: authorizes `action` and checks the token's shape and key version before any
 * store access, and derives the lookup hash. Only the current key version is valid.
 */
const visitorToken = Effect.fn("visitorToken")(function* (
  action: "share.open" | "share.pdf" | "share.logo",
) {
  const caller = yield* authorize(action);
  if (caller._tag !== "ShareLinkVisitor") return yield* Forbidden.make({ action });
  if (tokenVersion(caller.token) !== (yield* ShareLinkKeys).version) {
    return yield* unknownToken;
  }
  return { caller, tokenHash: yield* sha256Hex(caller.token) };
});

/** Inside a transaction: the caller's active link, row-locked; anything else is `NotFound`. */
const activeLink = Effect.fn("activeLink")(function* (tokenHash: string) {
  const keys = yield* ShareLinkKeys;
  const found = yield* (yield* ShareLinksRepo).lockByTokenHash(tokenHash);
  if (
    Option.isNone(found) ||
    found.value.revokedAt !== null ||
    found.value.keyVersion !== keys.version
  ) {
    return yield* unknownToken;
  }
  return found.value;
});

/** The shared document; a document the link no longer reaches is the same `NotFound`. */
const loadDocument = (link: ShareLink, language?: Locale) =>
  Effect.flatMap(DocumentDeliveryReads, (reads) =>
    reads.load(link.workspaceId, link.documentId, language === undefined ? {} : { language }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.fail(unknownToken)));

const isIssuer = (caller: ShareLinkVisitorCaller, link: ShareLink) => {
  const user = caller.signedInUser;
  return user === undefined
    ? Effect.succeed(false)
    : Effect.flatMap(ShareWorkspaces, (w) => w.isMember(link.workspaceId, user));
};

const event = Effect.fn("event")(function* (
  caller: ShareLinkVisitorCaller,
  link: ShareLink,
  kind: ShareViewEventRow["kind"],
  at: string,
) {
  return {
    id: yield* newId(ShareViewId.make),
    workspaceId: link.workspaceId,
    shareLinkId: link.id,
    kind,
    device: yield* ShareVisitorDevice,
    visitorHash: caller.visitor,
    at,
  } satisfies ShareViewEventRow;
});

/**
 * A view, deduplicated per visitor per hour; the first view sets the link's `viewedAt`. Runs
 * under the link's row lock (`activeLink`), so concurrent opens cannot both record.
 */
const recordView = Effect.fn("recordView")(function* (
  caller: ShareLinkVisitorCaller,
  link: ShareLink,
) {
  const repo = yield* ShareLinksRepo;
  const at = yield* nowIso;
  const since = DateTime.formatIso(
    DateTime.subtractDuration(DateTime.makeUnsafe(at), VIEW_DEDUP_MILLIS),
  );
  if (yield* repo.hasEventSince(link.workspaceId, link.id, caller.visitor, "view", since)) return;
  const value_1 = yield* event(caller, link, "view", at);
  yield* repo.recordEvent(value_1);
  yield* repo.markViewed(link.workspaceId, link.id, at);
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
    (entries) =>
      Option.getOrUndefined(EffectArray.findLast(entries, (e) => e.action === "document.edit"))
        ?.at ?? null,
  );

const sharedView = Effect.fn("sharedView")(function* (
  document: DeliveryDocument,
  link: ShareLink,
  pdfUrl: string,
  viewerIsIssuer: boolean,
) {
  const { record, view } = document;
  const creditNotes = yield* (yield* DocumentsRepo).getMany(
    record.workspaceId,
    EffectArray.map(
      EffectArray.filter(record.links, (l) => l.relation === "corrected_by"),
      (l) => l.id,
    ),
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
  const { caller, tokenHash } = yield* visitorToken("share.open");
  const keys = yield* ShareLinkKeys;
  return yield* (yield* CoreStore).transaction(
    Effect.gen(function* () {
      const link = yield* activeLink(tokenHash);
      const document = yield* loadDocument(link);
      const issuer = yield* isIssuer(caller, link);
      if (!issuer) yield* recordView(caller, link);
      return yield* sharedView(document, link, keys.pdfUrl(caller.token), issuer);
    }),
  );
}).pipe(orUnavailable);

const filenameOf = (number: string | null) =>
  `${EffectString.replace(/[^\p{L}\p{N}._-]+/gu, "-")(number ?? "document")}.pdf`;

/**
 * Renders the PDF, then records a download (unless the viewer is a Member of the issuer) in
 * a short transaction that re-checks the link: a failure before the bytes exist records nothing.
 */
const renderPdf = Effect.fn("pdf")(function* (opts?: { readonly language?: Locale }) {
  const { caller, tokenHash } = yield* visitorToken("share.pdf");
  const store = yield* CoreStore;
  const { document, link, issuer } = yield* store.transaction(
    Effect.gen(function* () {
      const active = yield* activeLink(tokenHash);
      const loaded = yield* loadDocument(active, opts?.language);
      return { document: loaded, link: active, issuer: yield* isIssuer(caller, active) };
    }),
  );
  const branding = yield* (yield* ShareWorkspaces).branding(link.workspaceId);
  const bytes = yield* (yield* DocumentDeliveryReads).render(document.view, {
    template: branding.pdfTemplate,
    language: opts?.language ?? document.record.language,
  });
  if (!issuer) {
    yield* store.transaction(
      Effect.gen(function* () {
        const current = yield* activeLink(tokenHash);
        const repo = yield* ShareLinksRepo;
        const at = yield* nowIso;
        const download = yield* event(caller, current, "download", at);
        yield* repo.recordEvent(download);
      }),
    );
  }
  return {
    filename: filenameOf(document.record.number),
    contentType: "application/pdf",
    bytes: Stream.make(bytes),
  } satisfies FileDownload;
});

export const pdf = (opts?: { readonly language?: Locale }) => renderPdf(opts).pipe(orUnavailable);

/** The issuing Workspace's logo; `NotFound` when it has none. Records nothing. */
export const logo = Effect.gen(function* () {
  const { tokenHash } = yield* visitorToken("share.logo");
  const link = yield* (yield* CoreStore).transaction(activeLink(tokenHash));
  const found = yield* (yield* ShareWorkspaces).logo(link.workspaceId);
  if (Option.isNone(found)) {
    return yield* NotFound.make({ entity: "ShareLink", id: "logo" });
  }
  return found.value;
}).pipe(orUnavailable);
