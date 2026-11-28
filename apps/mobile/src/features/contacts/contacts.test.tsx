import { describe, expect, mock, test } from "bun:test";
import {
  ContactId,
  CurrencyCode,
  ExpenseId,
  IsoDate,
  type RegistryResult,
  ReportView,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { text as uiText } from "@kvitbit/ui-port";
import {
  fromCause,
  ifMatchHeaders,
  ok,
  Paged,
  Remote as RemoteOps,
  sessionCookie,
} from "@kvitbit/ui-port/api";
import { OverrideForm, type Route } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { ReactElement } from "react";
import { ApiProvider, makeApiRunner } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { decodeExpenseDetail } from "../expenses/model";
import { decodeReportView } from "../reports/model";
import { loadSupplierExpenses } from "./expense-history";
import {
  applyRegistryPreview,
  applyRegistryToForm,
  buildContactInput,
  type ContactRecord,
  canEditContact,
  contactFormFromRecord,
  diffContactWithRegistry,
  emptyContactForm,
  filterVisibleContacts,
  findActiveContactByIco,
  isValidEmail,
  loadContactsQuery,
  parseContactView,
  parseReminderOffsets,
  summarizeContactReceivables,
  validateContactForm,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
const { TestProviders } = await import("../../testing/providers");
const { ContactDetailScreen, ContactDetailView, ContactEditorView } = await import(
  "./contact-detail-screen"
);
const { ContactsListContent } = await import("./contacts-list-screen");

const workspace: WorkspaceSummary = {
  id: WorkspaceId.make("01937c7a-0000-7000-8000-000000000001"),
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleStreet = "Budějovická 778/3a";

const sampleContact: ContactRecord = {
  id: ContactId.make("01937c7a-0000-7000-8000-000000000002"),
  roles: ["customer", "supplier"],
  name: "Asseco Central Europe, a.s.",
  ico: "27074358",
  dic: "CZ27074358",
  legalForm: "Akciová společnost",
  address: {
    street: sampleStreet,
    city: "Praha 4",
    postalCode: "140 00",
    country: "CZ",
  },
  billingEmails: ["fakturace@example.cz"],
  phone: "+420 222 111 000",
  note: "VIP",
  defaults: {
    currency: CurrencyCode.make("EUR"),
    dueDays: 30,
    reminderPolicy: { mode: "custom", offsetsDays: [3, 10] },
  },
  registryFetchedAt: "2026-11-20T10:00:00Z",
  archived: false,
  revision: 4,
};

const sampleRegistry: RegistryResult = {
  ico: "27074358",
  name: "Asseco Central Europe, a.s.",
  address: {
    street: "Nová ulice 12",
    city: "Praha 4",
    postalCode: "140 00",
    country: "CZ",
  },
  dic: "CZ27074358",
  legalForm: "Akciová společnost",
  registerEntry: "Městský soud v Praze, B 8525",
  terminatedOn: null,
};

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

const expenseId = (n: number) =>
  ExpenseId.make(`01937c7a-0000-7000-8000-${Str.padStart(12, "0")(String(n))}`);
const linkedExpense = (id: ExpenseId, supplierDocumentNumber: string) => ({
  id,
  revision: 1,
  status: "complete" as const,
  supplier: { contactId: sampleContact.id, name: "Old supplier name" },
  supplierDocumentNumber,
  issuedOn: "2026-11-26",
  total: "200",
  currency: "CZK",
});

describe("supplier expense history", () => {
  test("follows the expense cursor, matches the linked ID and preserves list order", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => expenseId(index + 10));
    const first = expenseId(10);
    const last = expenseId(16);
    const removed = expenseId(15);
    const queries: string[] = [];
    const reads: string[] = [];
    let active = 0;
    let peak = 0;
    let failLast = false;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (Str.endsWith("/expenses")(url.pathname)) {
          queries.push(url.search);
          const second = url.searchParams.has("cursor");
          return Response.json({
            items: Arr.map(second ? [first, last] : ids.slice(0, -1), (listedId) => ({
              id: listedId,
              status: "complete",
              supplierName: sampleContact.name,
            })),
            nextCursor: second ? null : "expense-next",
          });
        }
        const id = ExpenseId.make(Str.split("/")(url.pathname).at(-1) ?? "");
        reads.push(id);
        peak = Math.max(peak, ++active);
        await Bun.sleep(id === first ? 30 : 5);
        active -= 1;
        if (id === removed)
          return Response.json({ _tag: "NotFound", entity: "Expense", id }, { status: 404 });
        if (id === last && failLast) {
          return Response.json({ _tag: "Unavailable", dependency: "database" }, { status: 503 });
        }
        const record = linkedExpense(id, id === first ? "FIRST" : "LATER");
        return Response.json(
          id === first || id === last
            ? record
            : {
                ...record,
                supplier: {
                  contactId: id === expenseId(11) ? workspace.id : null,
                  name: sampleContact.name,
                },
              },
        );
      },
    });
    const runner = makeApiRunner(server.url.origin, sessionCookie, () => "en");
    try {
      const client = await runner.run(Effect.succeed);
      if (client._tag === "Err") throw new Error("Could not get the API client");
      const load = loadSupplierExpenses({
        api: client.value,
        workspaceId: workspace.id,
        contactId: sampleContact.id,
      });
      const expenses = await Effect.runPromise(load);
      expect(Arr.map(expenses, (expense) => expense.supplierDocumentNumber)).toEqual([
        "FIRST",
        "LATER",
      ]);
      expect(Arr.map(queries, (query) => new URLSearchParams(query).get("cursor"))).toEqual([
        null,
        "expense-next",
      ]);
      expect(
        Arr.map(queries, (query) => Arr.sort(new URLSearchParams(query).keys(), Order.String)),
      ).toEqual([["limit"], ["cursor", "limit"]]);
      expect(
        new Set(Arr.map(queries, (query) => new URLSearchParams(query).get("limit"))).size,
      ).toBe(1);
      expect(Arr.sort(reads, Order.String)).toEqual(Arr.sort(ids, Order.String));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);

      failLast = true;
      const failed = await Effect.runPromiseExit(load);
      expect(Exit.isFailure(failed) && fromCause(failed.cause)._tag).toBe("Unavailable");
    } finally {
      await runner.dispose();
      await server.stop(true);
    }
  });
});

describe("contacts model", () => {
  test("equivalent contact role selections produce identical create payloads", () => {
    const form = contactFormFromRecord(sampleContact);
    expect(buildContactInput({ ...form, roles: ["supplier", "customer"] })).toEqual(
      buildContactInput({ ...form, roles: ["customer", "supplier"] }),
    );
  });

  test("contact edit access requires a writable workspace and an active record", () => {
    expect(canEditContact(workspace, "new")).toBe(true);
    expect(canEditContact(workspace, sampleContact)).toBe(true);
    expect(canEditContact(workspace, { ...sampleContact, archived: true })).toBe(false);
    expect(canEditContact(workspace, null)).toBe(false);
    expect(canEditContact({ ...workspace, role: "accountant" }, sampleContact)).toBe(false);
    expect(canEditContact({ ...workspace, closed: true }, "new")).toBe(false);
    expect(contactFormFromRecord(sampleContact).editingRevision).toBe(sampleContact.revision);
  });

  test("ignores pages and cursors from a superseded contact query", () => {
    const first = loadContactsQuery({
      current: Paged.init<ContactRecord, { text?: string }>({}).paged,
      query: {},
    });
    const next = loadContactsQuery({
      current: first.paged,
      query: { text: "Asseco", role: "supplier" },
    });
    expect(next.paged.seq).toBeGreaterThan(first.paged.seq);
    const stale = Paged.receive(
      next.paged,
      first.paged.seq,
      ok({ items: [sampleContact], nextCursor: "staleCursor" }),
    );
    expect(stale.paged).toBe(next.paged);
    expect(stale.paged.nextCursor).toBeNull();
  });

  test("duplicate resolution checks the exact active IČO past partial matches and the edited row", async () => {
    const match = { ...sampleContact, id: ContactId.make("01937c7a-0000-7000-8000-0717103dff71") };
    const cursors: Array<string | null> = [];
    const found = await Effect.runPromise(
      findActiveContactByIco({
        ico: sampleContact.ico ?? "",
        excludedId: sampleContact.id,
        loadPage: (cursor) => {
          cursors.push(cursor);
          return Effect.succeed({
            items:
              cursor === null
                ? [
                    { ...sampleContact },
                    { ...match, ico: "127074358" },
                    { ...match, archived: true },
                  ]
                : [match],
            nextCursor: cursor === null ? "another-page" : null,
          });
        },
      }),
    );
    expect(cursors).toEqual([null, "another-page"]);
    expect(found?.id).toBe(match.id);
  });

  test("registry confirmation updates only the previewed fields with its original revision", async () => {
    const result = {
      ...sampleRegistry,
      name: "Corrected name",
      dic: null,
    };
    const requests: Array<unknown> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requests.push({
          method: req.method,
          path: new URL(req.url).pathname,
          revision: req.headers.get("if-match"),
          payload: await req.json(),
        });
        return Response.json(sampleContact);
      },
    });
    const api = makeApiRunner(server.url.origin, sessionCookie, () => "en");
    try {
      const saved = await api.run((client) =>
        applyRegistryPreview({
          contacts: client.contacts,
          workspaceId: workspace.id,
          preview: {
            result,
            items: diffContactWithRegistry(sampleContact, result),
            contactId: sampleContact.id,
            revision: sampleContact.revision,
          },
        }),
      );
      expect(saved._tag).toBe("Ok");
      expect(requests).toEqual([
        {
          method: "PUT",
          path: `/api/v1/workspaces/${workspace.id}/contacts/${sampleContact.id}`,
          revision: ifMatchHeaders(sampleContact.revision)["if-match"],
          payload: {
            name: "Corrected name",
            address: { street: "Nová ulice 12" },
          },
        },
      ]);
    } finally {
      await api.dispose();
      server.stop(true);
    }
  });

  test("contact balance totals every matching receivable and counts only overdue rows", () => {
    const row = (id: string, amount: string, daysOverdue: number) => ({
      id: "01937c7a-0000-7000-8000-000000000092",
      contact: { id, name: sampleContact.name },
      outstandingCzk: { amount, currency: "CZK" },
      daysOverdue,
    });
    const report = decodeReportView(
      ReportView.make({
        report: "receivables",
        buckets: [
          { documents: [row(sampleContact.id, "100.1", 0)] },
          { documents: [row(sampleContact.id, "5.45", 92), row("cnt_other", "99999", 50)] },
        ],
      }),
      "receivables",
    );
    if (report.report !== "receivables") throw new Error("Expected a receivables report");
    const result = summarizeContactReceivables({ report, contactId: sampleContact.id });
    expect(result.overdueCount).toBe(1);
    expect(result.outstanding.amount.pipe(BigDecimal.format)).toBe("105.55");
  });

  test("parses ContactView and filters archived contacts", () => {
    const parsed = parseContactView({
      ...sampleContact,
      archived: true,
    });
    expect(parsed?.id).toBe(sampleContact.id);
    expect(parsed?.archived).toBe(true);
    expect(parseContactView({ bad: true })).toBeNull();

    const list = [
      sampleContact,
      {
        ...sampleContact,
        id: ContactId.make("01937c7a-0000-7000-8000-1c8e94b928ff"),
        archived: true,
      },
    ];
    expect(filterVisibleContacts(list, false)).toHaveLength(1);
    expect(filterVisibleContacts(list, true)).toHaveLength(2);
  });

  test("applies ARES registry prefill without clobbering user emails, roles, or defaults", () => {
    const form = {
      ...emptyContactForm(),
      roles: ["supplier"] as const,
      billingEmails: ["ap@example.cz"],
      phone: "+420 123",
      overrides: OverrideForm.set(OverrideForm.init({}), "currency", CurrencyCode.make("EUR")),
    };
    const next = applyRegistryToForm(form, sampleRegistry);
    expect(next.name).toBe("Asseco Central Europe, a.s.");
    expect(next.ico).toBe("27074358");
    expect(next.street).toBe("Nová ulice 12");
    expect(next.roles).toEqual(["supplier"]);
    expect(next.billingEmails).toEqual(["ap@example.cz"]);
    expect(next.overrides.current.currency).toBe(CurrencyCode.make("EUR"));
  });

  test("diffs contact against ARES lookup to show only changed fields", () => {
    const diff = diffContactWithRegistry(sampleContact, sampleRegistry);
    expect(diff).toEqual([{ field: "street", before: sampleStreet, after: "Nová ulice 12" }]);
  });

  test("validates contact form (name, CZ ICO checksum, dueDays, custom reminder offsets)", () => {
    const emptyErrors = validateContactForm(emptyContactForm());
    expect(emptyErrors["name"]).toBe("name_required");

    const badIco = validateContactForm({
      ...emptyContactForm(),
      name: "Test",
      ico: "27074359", // wrong check digit
      country: "CZ",
    });
    expect(badIco["ico"]).toBe("ico_checksum");

    const foreign = {
      ...emptyContactForm(),
      name: "GmbH",
      country: "DE",
      dic: "DE123456789",
      street: "Musterstraße 12\n10115 Berlin",
    };
    expect(validateContactForm(foreign)).toEqual({});
    expect(buildContactInput(foreign)).toMatchObject({
      ico: null,
      dic: "DE123456789",
      address: { country: "DE", street: "Musterstraße 12\n10115 Berlin" },
    });
    expect(validateContactForm({ ...foreign, ico: "HRB12345" })["ico"]).toBe("ico_format");

    const badReminders = validateContactForm({
      ...emptyContactForm(),
      name: "Test",
      overrides: OverrideForm.setReminderPolicy(OverrideForm.init({}), {
        mode: "custom",
        offsetsDays: [],
      }),
      reminderOffsetsText: "3, abc",
    });
    expect(badReminders["defaults.reminderPolicy"]).toBe("reminder_offsets_invalid");
  });

  test("builds normalized ContactInput payload with defaults overrides", () => {
    const form = contactFormFromRecord(sampleContact);
    const input = buildContactInput({
      ...form,
      dic: "cz 270 743 58",
      dueDaysText: "21",
      reminderOffsetsText: "5, 15",
    });
    expect(input["dic"]).toBe("CZ27074358");
    expect(input.defaults?.dueDays).toBe(21);
    expect(input.defaults?.reminderPolicy).toEqual({
      mode: "custom",
      offsetsDays: [5, 15],
    });
    expect(parseReminderOffsets("1, 7, 14")).toEqual([1, 7, 14]);
    expect(parseReminderOffsets("-2")).toBeNull();
    expect(isValidEmail("a@b.cz")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });
});

describe("ContactsListContent", () => {
  test("renders contacts, hides archived by default, and navigates on press", () => {
    const visited: Route[] = [];
    const archivedContact: ContactRecord = {
      ...sampleContact,
      id: ContactId.make("01937c7a-0000-7000-8000-1c8e94b928ff"),
      name: "Archived Corp",
      archived: true,
    };
    const paged = {
      ...Paged.init<ContactRecord, Record<string, never>>({}).paged,
      status: "ready" as const,
      items: [sampleContact, archivedContact],
      nextCursor: "cursor_2",
      error: Option.none(),
    };
    let loadedMore = 0;
    const tree = hostTree(
      <ContactsListContent
        workspace={workspace}
        searchText=""
        onChangeSearchText={() => undefined}
        roleFilter="all"
        onChangeRoleFilter={() => undefined}
        showArchived={false}
        onChangeShowArchived={() => undefined}
        paged={paged}
        onRetry={() => undefined}
        onLoadMore={() => loadedMore++}
        onClearFilters={() => undefined}
        onNavigate={(r) => visited.push(r)}
      />,
      within,
    );

    const text = allText(tree);
    expect(text).toContain("Asseco Central Europe, a.s.");
    expect(text).not.toContain("Archived Corp");
    expect(text).toContain("Load more");

    const pressables = findAll<{ testID?: string; onPress?: () => void }>(tree, "Pressable");
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.testID === `contact-row-${sampleContact.id}`),
    )?.props.onPress?.();
    expect(visited[0]).toEqual({
      _tag: "Contact",
      ws: workspace.slug,
      id: sampleContact.id,
      mode: "view",
    });

    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => Str.includes("Load more")(allText(p))),
    )?.props.onPress?.();
    expect(loadedMore).toBe(1);
  });
});

describe("ContactDetailView & ContactEditorView", () => {
  test("blocks an accountant opening the new-contact URL directly", () => {
    const accountant = { ...workspace, role: "accountant" } as const;
    const tree = hostTree(<ContactDetailScreen />, (node) => (
      <TestProviders>
        <SessionProvider>
          <ApiProvider token={null}>
            <WorkspaceProvider
              workspace={accountant}
              workspaces={[accountant]}
              reload={() => undefined}
            >
              {node}
            </WorkspaceProvider>
          </ApiProvider>
        </SessionProvider>
      </TestProviders>
    ));
    expect(allText(tree)).toContain("Your role does not allow this action.");
    expect(findAll(tree, "TextInput")).toHaveLength(0);
  });

  test("shows contact particulars, billing defaults, and ARES diff preview", () => {
    let applied = 0;
    const routes: Route[] = [];
    const tree = hostTree(
      <ContactDetailView
        workspace={workspace}
        contact={sampleContact}
        documents={RemoteOps.ready([])}
        onRetryDocuments={() => undefined}
        receivables={RemoteOps.ready(null)}
        onRetryReceivables={() => undefined}
        expenses={RemoteOps.ready(
          Arr.filter(
            [decodeExpenseDetail(linkedExpense(expenseId(10), "SUP-2026-10"))],
            (expense) => expense !== null,
          ),
        )}
        onRetryExpenses={() => undefined}
        onEdit={() => undefined}
        onArchive={() => undefined}
        archiving={false}
        onRefreshAres={() => undefined}
        refreshingAres={false}
        aresDiff={{
          result: { ...sampleRegistry, terminatedOn: IsoDate.make("2026-05-01") },
          items: [{ field: "street", before: sampleStreet, after: "Nová ulice 12" }],
        }}
        onApplyAresDiff={() => applied++}
        onDismissAresDiff={() => undefined}
        applyingAres={false}
        onNavigate={(route) => routes.push(route)}
      />,
      within,
    );

    const text = allText(tree);
    expect(text).toContain("Asseco Central Europe, a.s.");
    expect(text).toContain("CZ27074358");
    expect(text).toContain("Changes from ARES");
    expect(text).toContain("Nová ulice 12");
    expect(text).toContain("terminated");
    expect(text).toContain("Expenses");
    const expenseRow = Option.getOrUndefined(
      Arr.findFirst(findAll<{ onPress?: () => void }>(tree, "Pressable"), (node) =>
        Str.includes("SUP-2026-10")(allText(node)),
      ),
    );
    expenseRow?.props.onPress?.();
    expect(routes).toEqual([
      { _tag: "Expense", ws: workspace.slug, id: expenseId(10), mode: "view" },
    ]);

    const applyBtn = Option.getOrUndefined(
      Arr.findFirst(findAll<{ onPress?: () => void }>(tree, "Pressable"), (p) =>
        Str.includes("Apply")(allText(p)),
      ),
    );
    applyBtn?.props.onPress?.();
    expect(applied).toBe(1);
  });

  test("shows stale revision reload banner and server field issues in editor", () => {
    let reloaded = 0;
    const tree = hostTree(
      <ContactEditorView
        isNew={false}
        form={contactFormFromRecord(sampleContact)}
        onChangeForm={() => undefined}
        clientErrors={{}}
        serverIssues={[{ path: ["ico"], text: uiText("issue.ico.checksum") }]}
        bannerError={null}
        staleRevision
        duplicateIco={false}
        onReloadLatest={() => reloaded++}
        onOpenContactsSearch={() => undefined}
        onLookupAres={() => undefined}
        lookingUpAres={false}
        aresNotice={null}
        onSave={() => undefined}
        onCancel={() => undefined}
        saving={false}
      />,
      within,
    );

    const text = allText(tree);
    expect(text).toContain("Reload");
    expect(text).toContain("Editing a contact does not change already issued documents.");

    const reloadBtn = Option.getOrUndefined(
      Arr.findFirst(findAll<{ onPress?: () => void }>(tree, "Pressable"), (p) =>
        Str.includes("Reload")(allText(p)),
      ),
    );
    reloadBtn?.props.onPress?.();
    expect(reloaded).toBe(1);
  });
});
