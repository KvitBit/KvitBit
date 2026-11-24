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
import { Paged, Remote as RemoteOps } from "@kvitbit/ui-port/api";
import { OverrideForm, type Route } from "@kvitbit/ui-port/view-models";
import { Option } from "effect";
import type { ReactElement } from "react";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import {
  applyRegistryToForm,
  buildContactInput,
  type ContactRecord,
  contactFormFromRecord,
  diffContactWithRegistry,
  emptyContactForm,
  filterVisibleContacts,
  isValidEmail,
  parseContactView,
  parseReminderOffsets,
  validateContactForm,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
type HostProps = import("../../testing/element-tree").HostProps;
const { TestProviders } = await import("../../testing/providers");
const { ContactDetailView, ContactEditorView } = await import("./contact-detail-screen");
const { ContactsListContent } = await import("./contacts-list-screen");

const workspace: WorkspaceSummary = {
  id: "ws_1" as WorkspaceId,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleContact: ContactRecord = {
  id: "cnt_1" as ContactId,
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

    const foreignId = validateContactForm({
      ...emptyContactForm(),
      name: "GmbH",
      ico: "HRB12345",
      country: "DE",
    });
    expect(foreignId.ico).toBeUndefined();

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
    pressables.find((p) => p.props.testID === "contact-row-cnt_1")?.props.onPress?.();
    expect(visited[0]).toEqual({
      _tag: "Contact",
      ws: workspace.slug,
      id: "cnt_1" as ContactId,
      mode: "view",
    });

    pressables.find((p) => allText(p).includes("Load more"))?.props.onPress?.();
    expect(loadedMore).toBe(1);
  });
});

describe("ContactDetailView & ContactEditorView", () => {
  test("shows contact particulars, billing defaults, and ARES diff preview", () => {
    let applied = 0;
    const tree = hostTree(
      <ContactDetailView
        workspace={workspace}
        contact={sampleContact}
        documents={RemoteOps.ready([])}
        onRetryDocuments={() => undefined}
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
