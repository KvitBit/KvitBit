import type { Role, WorkspaceSlug, WorkspaceSummary } from "@kvitbit/domain/contract";
import type { Period, Route, SettingsSection } from "@kvitbit/ui-port/view-models";

export type HiddenTabLabelKey = "shell.nav.templates" | "shell.nav.priceList" | "shell.nav.reports";
export type SettingsNavLabelKey = `settings.nav.${SettingsSection}`;
export type RoleLabelKey = `enum.role.${Role}`;

export interface MoreNavItem {
  readonly id: string;
  readonly labelKey: HiddenTabLabelKey;
  readonly route: Route;
}

export interface SettingsNavItem {
  readonly section: SettingsSection;
  readonly labelKey: SettingsNavLabelKey;
  readonly ownerOnly?: boolean;
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  { section: "issuingEntity", labelKey: "settings.nav.issuingEntity" },
  { section: "taxRegime", labelKey: "settings.nav.taxRegime" },
  { section: "bankAccounts", labelKey: "settings.nav.bankAccounts" },
  { section: "branding", labelKey: "settings.nav.branding" },
  { section: "numbering", labelKey: "settings.nav.numbering" },
  { section: "documentDefaults", labelKey: "settings.nav.documentDefaults" },
  { section: "reminders", labelKey: "settings.nav.reminders" },
  { section: "team", labelKey: "settings.nav.team" },
  { section: "apiKeys", labelKey: "settings.nav.apiKeys" },
  { section: "connectedApps", labelKey: "settings.nav.connectedApps" },
  { section: "dangerZone", labelKey: "settings.nav.dangerZone", ownerOnly: true },
];

export const currentYearPeriod = (now: Date = new Date()): Period =>
  String(now.getFullYear()) as Period;

export const hiddenTabItems = (
  ws: WorkspaceSlug,
  now: Date = new Date(),
): ReadonlyArray<MoreNavItem> => [
  { id: "templates", labelKey: "shell.nav.templates", route: { _tag: "Templates", ws } },
  { id: "priceList", labelKey: "shell.nav.priceList", route: { _tag: "PriceList", ws } },
  {
    id: "reports",
    labelKey: "shell.nav.reports",
    route: { _tag: "Reports", ws, report: "revenue", period: currentYearPeriod(now) },
  },
];

export const filterWorkspaces = (
  workspaces: ReadonlyArray<WorkspaceSummary>,
  query: string,
): ReadonlyArray<WorkspaceSummary> => {
  const q = query.trim().toLowerCase();
  if (q === "") return workspaces;
  return workspaces.filter(
    (w) => w.name.toLowerCase().includes(q) || w.slug.toLowerCase().includes(q),
  );
};

export const roleLabelKey = (role: Role): RoleLabelKey => `enum.role.${role}`;
