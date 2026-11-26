import { describe, expect, mock, test } from "bun:test";
import type {
  ContactId,
  CurrencyCode,
  IsoDate,
  RegistryResult,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { text as uiText } from "@kvitbit/ui-port";
import {
  ifMatchHeaders,
  ok,
  Paged,
  Remote as RemoteOps,
  sessionCookie,
} from "@kvitbit/ui-port/api";
import { OverrideForm, type Route } from "@kvitbit/ui-port/view-models";
import { BigDecimal, Effect, Option } from "effect";
import type { ReactElement } from "react";
import { ApiProvider, makeApiRunner } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { decodeReportView } from "../reports/model";
import {
  applyRegistryPreview,
  applyRegistryToForm,
  buildContactInput,
  type ContactRecord,
  contactFormFromRecord,
  diffContactWithRegistry,
  emptyContactForm,
  filterVisibleContacts,
  findActiveContactByIco,
  isValidEmail,
  parseContactView,
  parseReminderOffsets,
  summarizeContactReceivables,
  validateContactForm,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
type HostProps = import("../../testing/element-tree").HostProps;
const { TestProviders } = await import("../../testing/providers");
const { ContactDetailScreen, ContactDetailView, ContactEditorView } = await import(
  "./contact-detail-screen"
);
const { ContactsListContent, loadContactsQuery } = await import("./contacts-list-screen");

const workspace: WorkspaceSummary = {
  id: "01937c7a-0000-7000-8000-000000000001" as WorkspaceId,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleContact: ContactRecord = {
  id: "01937c7a-0000-7000-8000-000000000002" as ContactId,
  roles: ["customer", "supplier"],
  name: "Asseco Central Europe, a.s.",
  ico: "27074358",
  dic: "CZ27074358",
  legalForm: "Akciová společnost",
  address: {
    street: "Budějovická 778/3a",
    city: "Praha 4",
    postalCode: "140 00",
    country: "CZ",
  },
  billingEmails: ["fakturace@example.cz"],
  phone: "+420 222 111 000",
  note: "VIP",
  defaults: {
    currency: "EUR" as CurrencyCode,
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

describe("contacts model", () => {
  test("ignores pages and cursors from a superseded contact query", () => {
    const first = loadContactsQuery(Paged.init<ContactRecord, { text?: string }>({}).paged, {});
    const next = loadContactsQuery(first.paged, { text: "Asseco", role: "supplier" });
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
    const match = { ...sampleContact, id: "cnt_existing" as ContactId };
    const cursors: Array<string | null> = [];
    const found = await Effect.runPromise(
      findActiveContactByIco(sampleContact.ico ?? "", sampleContact.id, (cursor) => {
        cursors.push(cursor);
        return Effect.succeed({
          items:
            cursor === null
              ? [{ ...sampleContact }, { ...match, ico: "127074358" }, { ...match, archived: true }]
              : [match],
          nextCursor: cursor === null ? "another-page" : null,
        });
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
        applyRegistryPreview(client.contacts, workspace.id, {
          result,
          items: diffContactWithRegistry(sampleContact, result),
          contactId: sampleContact.id,
          revision: sampleContact.revision,
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
      contact: { id, name: sampleContact.name },
      outstandingCzk: { amount, currency: "CZK" },
      daysOverdue,
    });
    const report = decodeReportView(
      {
        report: "receivables",
        buckets: [
          { documents: [row(sampleContact.id, "100.1", 0)] },
          { documents: [row(sampleContact.id, "5.45", 92), row("cnt_other", "99999", 50)] },
        ],
      },
      "receivables",
    );
    if (report.report !== "receivables") throw new Error("Expected a receivables report");
    const result = summarizeContactReceivables(report, sampleContact.id);
    expect(result.overdueCount).toBe(1);
    expect(BigDecimal.format(result.outstanding.amount)).toBe("105.55");
  });

  test("parses ContactView and filters archived contacts", () => {
    const parsed = parseContactView({
      ...sampleContact,
      archived: true,
    });
    expect(parsed?.id).toBe(sampleContact.id);
    expect(parsed?.archived).toBe(true);
    expect(parseContactView({ bad: true })).toBeNull();

    const list = [sampleContact, { ...sampleContact, id: "cnt_2" as ContactId, archived: true }];
    expect(filterVisibleContacts(list, false)).toHaveLength(1);
    expect(filterVisibleContacts(list, true)).toHaveLength(2);
  });

  test("applies ARES registry prefill without clobbering user emails, roles, or defaults", () => {
    const form = {
      ...emptyContactForm(),
      roles: ["supplier"] as const,
      billingEmails: ["ap@example.cz"],
      phone: "+420 123",
      overrides: OverrideForm.set(OverrideForm.init({}), "currency", "EUR" as CurrencyCode),
    };
    const next = applyRegistryToForm(form, sampleRegistry);
    expect(next.name).toBe("Asseco Central Europe, a.s.");
    expect(next.ico).toBe("27074358");
    expect(next.street).toBe("Nová ulice 12");
    expect(next.roles).toEqual(["supplier"]);
    expect(next.billingEmails).toEqual(["ap@example.cz"]);
    expect(next.overrides.current.currency).toBe("EUR" as CurrencyCode);
  });

  test("diffs contact against ARES lookup to show only changed fields", () => {
    const diff = diffContactWithRegistry(sampleContact, sampleRegistry);
    expect(diff).toEqual([
      { field: "street", before: "Budějovická 778/3a", after: "Nová ulice 12" },
    ]);
  });

  test("validates contact form (name, CZ ICO checksum, dueDays, custom reminder offsets)", () => {
    const emptyErrors = validateContactForm(emptyContactForm());
    expect(emptyErrors.name).toBe("name_required");

    const badIco = validateContactForm({
      ...emptyContactForm(),
      name: "Test",
      ico: "27074359", // wrong check digit
      country: "CZ",
    });
    expect(badIco.ico).toBe("ico_checksum");

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
    expect(validateContactForm({ ...foreign, ico: "HRB12345" }).ico).toBe("ico_format");

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
    }) as Record<string, unknown>;
    expect(input.dic).toBe("CZ27074358");
    expect((input.defaults as Record<string, unknown>).dueDays).toBe(21);
    expect((input.defaults as Record<string, unknown>).reminderPolicy).toEqual({
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
      id: "cnt_2" as ContactId,
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
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("Asseco Central Europe, a.s.");
    expect(text).not.toContain("Archived Corp");
    expect(text).toContain("Load more");

    const pressables = findAll<{ testID?: string; onPress?: () => void }>(tree, "Pressable");
    pressables.find((p) => p.props.testID === `contact-row-${sampleContact.id}`)?.props.onPress?.();
    expect(visited[0]).toEqual({
      _tag: "Contact",
      ws: workspace.slug,
      id: sampleContact.id,
      mode: "view",
    });

    pressables.find((p) => allText(p).includes("Load more"))?.props.onPress?.();
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
    const tree = hostTree(
      <ContactDetailView
        workspace={workspace}
        contact={sampleContact}
        documents={RemoteOps.ready([])}
        onRetryDocuments={() => undefined}
        receivables={RemoteOps.ready(null)}
        onRetryReceivables={() => undefined}
        onEdit={() => undefined}
        onArchive={() => undefined}
        archiving={false}
        onRefreshAres={() => undefined}
        refreshingAres={false}
        aresDiff={{
          result: { ...sampleRegistry, terminatedOn: "2026-05-01" as IsoDate },
          items: [{ field: "street", before: "Budějovická 778/3a", after: "Nová ulice 12" }],
        }}
        onApplyAresDiff={() => applied++}
        onDismissAresDiff={() => undefined}
        applyingAres={false}
        onNavigate={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("Asseco Central Europe, a.s.");
    expect(text).toContain("CZ27074358");
    expect(text).toContain("Changes from ARES");
    expect(text).toContain("Nová ulice 12");
    expect(text).toContain("terminated");

    const applyBtn = findAll<{ onPress?: () => void }>(tree, "Pressable").find((p) =>
      allText(p).includes("Apply"),
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
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("Reload");
    expect(text).toContain("Editing a contact does not change already issued documents.");

    const reloadBtn = findAll<{ onPress?: () => void }>(tree, "Pressable").find((p) =>
      allText(p).includes("Reload"),
    );
    reloadBtn?.props.onPress?.();
    expect(reloaded).toBe(1);
  });
});
