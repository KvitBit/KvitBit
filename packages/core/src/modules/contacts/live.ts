/**
 * `Contacts` (core-ports 4.2): Contacts with their particulars, roles and billing overrides.
 * Writes are audited on subject `Contact` (`contact.save`, `contact.archive`); `fromIco` saves
 * through the registry and is audited as `contact.save`.
 */
import type {
  AuditEntry,
  ContactId,
  ContactInput,
  ContactRole,
  CurrentCaller,
  Forbidden,
  Invalid,
  Page,
  RegistryResult,
  RequestOptions,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, Contacts, NotFound } from "@kvitbit/domain/contract";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { CoreStore } from "../../store/CoreStore";
import { RegistryLookup, validateIco } from "../workspaces/registry";
import { decodeInput, foldText, invalidAt } from "./input";
import type { ContactRow, ContactSaveFields, ContactViewData } from "./model";
import {
  ContactSaveFields as ContactSaveFieldsSchema,
  ContactSavePayload,
  ContactViewSchema,
  normalizeDefaults,
  toContactView,
  uniqueRoles,
} from "./model";
import { CONTACTS_ACTIVE_ICO_UNIQUE, ContactsRepo } from "./repo";

/** Page size of `search` (the domain query takes no limit; the ui-port default). */
export const CONTACT_PAGE_SIZE = 50;

/**
 * The Contacts methods with the errors the spec gives them. The domain tag's signatures omit
 * some (see `ContactsLive`).
 */
export interface ContactsImpl {
  readonly fromIco: (
    ico: string,
    opts?: { readonly role?: ContactRole },
  ) => Effect.Effect<ContactViewData, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>;
  readonly save: (
    input: ContactInput & { readonly id?: ContactId; readonly expectedRevision?: number },
    opts?: RequestOptions,
  ) => Effect.Effect<
    ContactViewData,
    Invalid | NotFound | Conflict | Forbidden | Unavailable,
    CurrentCaller
  >;
  readonly archive: (
    id: ContactId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly get: (
    id: ContactId,
  ) => Effect.Effect<ContactViewData, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly search: (q: {
    readonly text?: string;
    readonly role?: ContactRole;
    readonly cursor?: string;
  }) => Effect.Effect<Page<ContactViewData>, Invalid | Forbidden | Unavailable, CurrentCaller>;
}

const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const duplicateIco = new Conflict({ reason: "duplicate" });

/** A broken active-IČO index is the duplicate Conflict; any other unique index is a bug. */
const onUniqueViolation = (violation: UniqueViolation): Effect.Effect<never, Conflict> =>
  violation.constraint === CONTACTS_ACTIVE_ICO_UNIQUE
    ? Effect.fail(duplicateIco)
    : Effect.die(violation);

/** One change per view field that differs (audit `changes`, rule C5). */
const changesOf = (
  before: ContactViewData | null,
  after: ContactViewData,
): AuditEntry["changes"] => {
  const keys = Object.keys(after) as Array<keyof ContactViewData>;
  return keys
    .filter((key) => key !== "id" && key !== "revision")
    .filter((key) => before === null || JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ path: key, before: before === null ? null : before[key], after: after[key] }));
};

/** Domain checks on decoded fields that the schema does not express. */
const checkFields = (fields: ContactSaveFields): Effect.Effect<void, Invalid> =>
  Effect.gen(function* () {
    if (fields.ico !== undefined && fields.ico !== null) yield* validateIco(fields.ico, ["ico"]);
    const defaults = fields.defaults;
    if (defaults?.dueDays !== undefined && defaults.dueDays < 0) {
      return yield* invalidAt(["defaults", "dueDays"], "request.malformed");
    }
    const policy = defaults?.reminderPolicy;
    if (policy?.mode === "custom") {
      const index = policy.offsetsDays.findIndex((days) => days < 0);
      if (index !== -1) {
        return yield* invalidAt(
          ["defaults", "reminderPolicy", "offsetsDays", index],
          "request.malformed",
        );
      }
    }
  });

/** Applies `save` fields to a stored Contact (patch semantics, see `ContactSaveFields`). */
const applyFields = (row: ContactRow, fields: ContactSaveFields, now: string): ContactRow => ({
  ...row,
  roles: fields.roles !== undefined ? uniqueRoles(fields.roles) : row.roles,
  name: fields.name ?? row.name,
  ico: fields.ico !== undefined ? fields.ico : row.ico,
  dic: fields.dic !== undefined ? fields.dic : row.dic,
  legalForm: fields.legalForm !== undefined ? fields.legalForm : row.legalForm,
  address: {
    street: fields.address?.street !== undefined ? fields.address.street : row.address.street,
    city: fields.address?.city !== undefined ? fields.address.city : row.address.city,
    postalCode:
      fields.address?.postalCode !== undefined ? fields.address.postalCode : row.address.postalCode,
    country: fields.address?.country ?? row.address.country,
  },
  billingEmails: fields.billingEmails ?? row.billingEmails,
  phone: fields.phone !== undefined ? fields.phone : row.phone,
  note: fields.note !== undefined ? fields.note : row.note,
  defaults: fields.defaults !== undefined ? normalizeDefaults(fields.defaults) : row.defaults,
  updatedAt: now,
});

const emptyOrNull = (value: string): string | null => (value.trim() === "" ? null : value);

/** Particulars taken from the registry; VAT-payer status is not among them. */
const registryParticulars = (result: RegistryResult) => ({
  name: result.name,
  dic: result.dic === null ? null : emptyOrNull(result.dic),
  legalForm: emptyOrNull(result.legalForm),
  address: {
    street: emptyOrNull(result.address.street),
    city: emptyOrNull(result.address.city),
    postalCode: emptyOrNull(result.address.postalCode),
    country: /^[A-Z]{2}$/.test(result.address.country) ? result.address.country : "CZ",
  },
});

/** Whether two rows differ in anything but bookkeeping (timestamps, revision). */
const sameContent = (a: ContactRow, b: ContactRow): boolean => {
  const strip = ({ revision, updatedAt, registryFetchedAt, ...rest }: ContactRow) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

// Search cursors: opaque, bound to the filter they came from (http-mcp-contracts 362).

interface CursorData {
  readonly f: string;
  readonly n: string;
  readonly i: string;
}

const encodeCursor = (data: CursorData): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decodeCursor = (cursor: string): CursorData | null => {
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "f" in parsed &&
      "n" in parsed &&
      "i" in parsed &&
      typeof parsed.f === "string" &&
      typeof parsed.n === "string" &&
      typeof parsed.i === "string"
    ) {
      return { f: parsed.f, n: parsed.n, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
};

export const makeContacts: Effect.Effect<
  ContactsImpl,
  never,
  CoreStore | IdGenerator | ContactsRepo | RegistryLookup
> = Effect.gen(function* () {
  const store = yield* CoreStore;
  const repo = yield* ContactsRepo;
  // Only these services: the caller stays the one of each call.
  const context = Context.make(CoreStore, store).pipe(
    Context.add(IdGenerator, yield* IdGenerator),
    Context.add(ContactsRepo, repo),
  );
  const registry = yield* RegistryLookup;

  /** Fails with `Conflict{duplicate}` when another active Contact holds `row.ico`. */
  const ensureIcoFree = (row: ContactRow): Effect.Effect<void, Conflict | StoreUnavailable> =>
    row.ico === null || row.archivedAt !== null
      ? Effect.void
      : Effect.flatMap(repo.findActiveByIco(row.workspaceId, row.ico), (holder) =>
          Option.isSome(holder) && holder.value.id !== row.id
            ? Effect.fail(duplicateIco)
            : Effect.void,
        );

  const audit = (before: ContactRow | null, after: ContactRow, action: string) =>
    appendAudit({
      workspaceId: after.workspaceId,
      subject: { entity: "Contact", id: after.id },
      action,
      revision: after.revision,
      changes: changesOf(before === null ? null : toContactView(before), toContactView(after)),
    });

  const create = (workspaceId: WorkspaceId, fields: ContactSaveFields) =>
    Effect.gen(function* () {
      if (fields.name === undefined) return yield* invalidAt(["name"], "request.malformed");
      const now = yield* nowIso;
      const row: ContactRow = {
        id: yield* newId<ContactId>(),
        workspaceId,
        revision: 1,
        roles: uniqueRoles(fields.roles ?? ["customer"]),
        name: fields.name,
        ico: fields.ico ?? null,
        dic: fields.dic ?? null,
        legalForm: fields.legalForm ?? null,
        address: {
          street: fields.address?.street ?? null,
          city: fields.address?.city ?? null,
          postalCode: fields.address?.postalCode ?? null,
          country: fields.address?.country ?? "CZ",
        },
        billingEmails: fields.billingEmails ?? [],
        phone: fields.phone ?? null,
        note: fields.note ?? null,
        defaults: normalizeDefaults(fields.defaults),
        registryFetchedAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* ensureIcoFree(row);
      const inserted = yield* repo
        .insert(row)
        .pipe(Effect.catchTag("UniqueViolation", onUniqueViolation));
      yield* audit(null, inserted, "contact.save");
      return inserted;
    });

  const edit = (
    workspaceId: WorkspaceId,
    id: ContactId,
    expectedRevision: number | undefined,
    fields: ContactSaveFields,
  ) =>
    Effect.gen(function* () {
      // An edit without expectedRevision is stale by definition (rule C2): report the current one.
      const current =
        expectedRevision === undefined
          ? yield* Effect.flatMap(repo.lock(workspaceId, id), (row) =>
              Effect.fail(
                new Conflict({ reason: "revision_changed", currentRevision: row.revision }),
              ),
            )
          : yield* repo.getForUpdate(workspaceId, id, expectedRevision);
      const next = applyFields(current, fields, yield* nowIso);
      if (sameContent(current, next)) return current;
      yield* ensureIcoFree(next);
      const updated = yield* repo
        .update(next, current.revision)
        .pipe(Effect.catchTag("UniqueViolation", onUniqueViolation));
      yield* audit(current, updated, "contact.save");
      return updated;
    });

  /** fromIco on an existing active Contact: refresh registry particulars, add the role. */
  const refresh = (
    existing: ContactRow,
    result: RegistryResult,
    role: ContactRole | undefined,
    now: string,
  ) =>
    Effect.gen(function* () {
      const current = yield* repo.lock(existing.workspaceId, existing.id);
      const next: ContactRow = {
        ...current,
        ...registryParticulars(result),
        roles: role === undefined ? current.roles : uniqueRoles([...current.roles, role]),
        registryFetchedAt: now,
        updatedAt: now,
      };
      if (sameContent(current, next)) return current;
      // The row is locked (no revision race) and the IČO does not change: both are bugs here.
      const updated = yield* repo
        .update(next, current.revision)
        .pipe(Effect.catchTags({ UniqueViolation: Effect.die, Conflict: Effect.die }));
      yield* audit(current, updated, "contact.save");
      return updated;
    });

  const impl: ContactsImpl = {
    fromIco: (ico, opts) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
        // Checksum, cache and serialized registry call, outside the transaction.
        const result = yield* registry.lookup(ico);
        if (result === null) return yield* new NotFound({ entity: "Contact", id: ico });
        const role = opts?.role;
        const row = yield* store.transaction(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const existing = yield* repo.findActiveByIco(workspaceId, ico);
            if (Option.isSome(existing)) return yield* refresh(existing.value, result, role, now);
            const fresh: ContactRow = {
              id: yield* newId<ContactId>(),
              workspaceId,
              revision: 1,
              roles: [role ?? "customer"],
              ico,
              ...registryParticulars(result),
              billingEmails: [],
              phone: null,
              note: null,
              defaults: normalizeDefaults(undefined),
              registryFetchedAt: now,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            };
            // Savepoint: a concurrent fromIco may insert the same IČO first; then refresh it.
            return yield* store.transaction(repo.insert(fresh)).pipe(
              Effect.tap((inserted) => audit(null, inserted, "contact.save")),
              Effect.catchTag("UniqueViolation", (violation) =>
                Effect.flatMap(repo.findActiveByIco(workspaceId, ico), (winner) =>
                  Option.isSome(winner)
                    ? refresh(winner.value, result, role, now)
                    : Effect.die(violation),
                ),
              ),
            );
          }),
        );
        return toContactView(row);
      }).pipe(Effect.provide(context), orUnavailable),

    save: (input, opts) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
        const { id, expectedRevision, ...rest } = input;
        const fields = yield* decodeInput(ContactSaveFieldsSchema, rest);
        yield* checkFields(fields);
        const row = yield* withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "Contacts.save",
            payload: {
              schema: ContactSavePayload,
              value: {
                fields,
                ...(id !== undefined ? { id } : {}),
                ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              },
            },
            result: ContactViewSchema,
          },
          Effect.gen(function* () {
            const saved =
              id === undefined
                ? yield* create(workspaceId, fields)
                : yield* edit(workspaceId, id, expectedRevision, fields);
            return toContactView(saved);
          }),
        );
        return row;
      }).pipe(Effect.provide(context), orUnavailable),

    archive: (id) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
        yield* store.transaction(
          Effect.gen(function* () {
            // Idempotent by state (rule C6): archiving an archived Contact changes nothing.
            const current = yield* repo.lock(workspaceId, id);
            if (current.archivedAt !== null) return;
            const now = yield* nowIso;
            const updated = yield* repo
              .update({ ...current, archivedAt: now, updatedAt: now }, current.revision)
              .pipe(Effect.catchTags({ UniqueViolation: Effect.die, Conflict: Effect.die }));
            yield* audit(current, updated, "contact.archive");
          }),
        );
      }).pipe(Effect.provide(context), orUnavailable),

    get: (id) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.read");
        return toContactView(yield* repo.get(workspaceId, id));
      }).pipe(Effect.provide(context), orUnavailable),

    search: (q) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.read");
        const text = q.text === undefined ? "" : foldText(q.text);
        const filter = JSON.stringify([text, q.role ?? null]);
        let after: readonly [string, string] | undefined;
        if (q.cursor !== undefined) {
          const cursor = decodeCursor(q.cursor);
          if (cursor === null || cursor.f !== filter) {
            return yield* invalidAt(["cursor"], "page.cursor_mismatch");
          }
          after = [cursor.n, cursor.i];
        }
        const rows = yield* repo.search(workspaceId, {
          ...(text !== "" ? { text } : {}),
          ...(q.role !== undefined ? { role: q.role } : {}),
          ...(after !== undefined ? { after } : {}),
          limit: CONTACT_PAGE_SIZE + 1,
        });
        const page = rows.slice(0, CONTACT_PAGE_SIZE);
        const last = page.at(-1);
        return {
          items: page.map(toContactView),
          nextCursor:
            rows.length > CONTACT_PAGE_SIZE && last !== undefined
              ? encodeCursor({ f: filter, n: last.name, i: last.id })
              : null,
        };
      }).pipe(Effect.provide(context), orUnavailable),
  };
  return impl;
});

/**
 * `Contacts` on CoreStore, IdGenerator, `ContactsRepo` and the process-wide `RegistryLookup`
 * (shared with `Workspaces.lookupCompany`, rule W9).
 *
 * The one cast in this module: the frozen domain tag omits errors the spec requires, so the
 * honest `ContactsImpl` is exposed as the tag's shape (agreed with ci-workspaces, board #341).
 * Gaps for a domain fix: `fromIco` lacks `NotFound` (no registry record); `search` lacks
 * `Invalid{page.cursor_mismatch}` (http-mcp-contracts 362); every method lacks
 * `Unavailable{database}` (`fromIco` has `Unavailable` already); `save` decode failures are
 * `Invalid` (in the signature).
 */
export const ContactsLive: Layer.Layer<
  Contacts,
  never,
  CoreStore | IdGenerator | ContactsRepo | RegistryLookup
> = Layer.effect(
  Contacts,
  makeContacts as unknown as Effect.Effect<
    Contacts["Service"],
    never,
    CoreStore | IdGenerator | ContactsRepo | RegistryLookup
  >,
);
