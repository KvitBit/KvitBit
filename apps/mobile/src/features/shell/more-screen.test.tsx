import { describe, expect, mock, test } from "bun:test";
import type { WorkspaceId, WorkspaceSlug, WorkspaceSummary } from "@kvitbit/domain/contract";
import { SettingsSection } from "@kvitbit/ui-port/view-models";
import type { ReactElement } from "react";
import { SessionProvider } from "../../session/session-provider";
import { allText, findAll, type HostProps, hostTree } from "../../testing/element-tree";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { filterWorkspaces, hiddenTabItems, SETTINGS_NAV_ITEMS } from "./more-model";

const pushed: string[] = [];
mock.module("expo-router", () => ({
  ...expoRouterStandIn(),
  router: {
    back: () => undefined,
    canGoBack: () => false,
    push: (href: string) => pushed.push(href),
    replace: (href: string) => pushed.push(href),
  },
}));

const { MoreScreen } = await import("./more-screen");

const ws = (overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: "ws-1" as WorkspaceId,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
  ...overrides,
});

describe("more-model", () => {
  test("covers every SettingsSection in SETTINGS_NAV_ITEMS", () => {
    const listed = new Set(SETTINGS_NAV_ITEMS.map((i) => i.section));
    for (const literal of SettingsSection.literals) {
      expect(listed.has(literal)).toBe(true);
    }
  });

  test("hiddenTabItems builds workspace-scoped routes for Templates, Price List, and Reports", () => {
    const items = hiddenTabItems("acme" as WorkspaceSlug, new Date(2026, 5, 1));
    expect(items.map((i) => i.id)).toEqual(["templates", "priceList", "reports"]);
    expect(items[2]?.route).toEqual({
      _tag: "Reports",
      ws: "acme" as WorkspaceSlug,
      report: "revenue",
      period: "2026",
    });
  });

  test("filterWorkspaces filters by name and slug case-insensitively", () => {
    const all = [
      ws({ id: "ws-1" as WorkspaceId, slug: "acme" as WorkspaceSlug, name: "Acme s.r.o." }),
      ws({ id: "ws-2" as WorkspaceId, slug: "beta-studio" as WorkspaceSlug, name: "Beta Studio" }),
    ];
    expect(filterWorkspaces(all, "")).toHaveLength(2);
    expect(filterWorkspaces(all, "BETA")).toHaveLength(1);
    expect(filterWorkspaces(all, "acme")).toHaveLength(1);
    expect(filterWorkspaces(all, "zzz")).toHaveLength(0);
  });
});

describe("MoreScreen", () => {
  const renderMore = (active: WorkspaceSummary, all: ReadonlyArray<WorkspaceSummary> = [active]) =>
    hostTree(<MoreScreen />, (node: ReactElement) => (
      <TestProviders locale="en">
        <SessionProvider origin="http://localhost">
          <WorkspaceProvider workspace={active} workspaces={all} reload={() => undefined}>
            {node}
          </WorkspaceProvider>
        </SessionProvider>
      </TestProviders>
    )) as ReactElement<HostProps>;

  test("renders workspace switcher, hidden tabs, all settings sections, account links, and sign out", () => {
    const tree = renderMore(ws());
    const text = allText(tree);
    expect(text).toContain("Acme s.r.o.");
    expect(text).toContain("Templates");
    expect(text).toContain("Price list");
    expect(text).toContain("Reports");
    expect(text).toContain("Business details");
    expect(text).toContain("Tax regime");
    expect(text).toContain("Bank accounts");
    expect(text).toContain("Branding");
    expect(text).toContain("Numbering");
    expect(text).toContain("Document defaults");
    expect(text).toContain("Reminders");
    expect(text).toContain("Team");
    expect(text).toContain("API keys");
    expect(text).toContain("Connected apps");
    expect(text).toContain("Danger zone");
    expect(text).toContain("Profile");
    expect(text).toContain("Security");
    expect(text).toContain("Sign out");
  });

  test("navigates to hidden tab and settings section when rows are pressed", () => {
    pushed.length = 0;
    const tree = renderMore(ws());
    const pressables = findAll<{ testID?: string; onPress?: () => void }>(tree, "Pressable");
    const templatesRow = pressables.find((p) => p.props.testID === "more-nav-templates");
    const brandingRow = pressables.find((p) => p.props.testID === "more-settings-branding");
    expect(templatesRow).toBeDefined();
    expect(brandingRow).toBeDefined();
    templatesRow?.props.onPress?.();
    brandingRow?.props.onPress?.();
    expect(pushed).toContain("/w/acme/templates");
    expect(pushed).toContain("/w/acme/settings/branding");
  });

  test("shows closed workspace warning and read-only badge for member role", () => {
    const closedTree = renderMore(ws({ closed: true }));
    expect(allText(closedTree)).toContain("This workspace is closed");

    const memberTree = renderMore(ws({ role: "member" }));
    expect(allText(memberTree)).toContain("Read only");
  });
});
