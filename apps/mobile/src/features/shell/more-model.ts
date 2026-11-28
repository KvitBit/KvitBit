import type { Role, WorkspaceSlug, WorkspaceSummary } from "@kvitbit/domain/contract";
import { Period, type Route, type SettingsSection } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

type HiddenTabLabelKey = "shell.nav.templates" | "shell.nav.priceList" | "shell.nav.reports";
type SettingsNavLabelKey = `settings.nav.${SettingsSection}`;
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

const currentYearPeriod = (now: Date = DateTime.toDateUtc(DateTime.nowUnsafe())): Period =>
  Period.make(String(now.getFullYear()));

export const hiddenTabItems = ({
  ws,
  now = DateTime.toDateUtc(DateTime.nowUnsafe()),
}: {
  readonly ws: WorkspaceSlug;
  readonly now?: Date;
}): ReadonlyArray<MoreNavItem> => [
  { id: "templates", labelKey: "shell.nav.templates", route: { _tag: "Templates", ws } },
  { id: "priceList", labelKey: "shell.nav.priceList", route: { _tag: "PriceList", ws } },
  {
    id: "reports",
    labelKey: "shell.nav.reports",
    route: { _tag: "Reports", ws, report: "revenue", period: currentYearPeriod(now) },
  },
];

export const filterWorkspaces: {
  (query: string): (workspaces: ReadonlyArray<WorkspaceSummary>) => ReadonlyArray<WorkspaceSummary>;
  (workspaces: ReadonlyArray<WorkspaceSummary>, query: string): ReadonlyArray<WorkspaceSummary>;
} = Fn.dual(
  2,
  (workspaces: ReadonlyArray<WorkspaceSummary>, query: string): ReadonlyArray<WorkspaceSummary> => {
    const q = Str.toLowerCase(Str.trim(query));
    if (q === "") return workspaces;
    return Arr.filter(
      workspaces,
      (w) => Str.includes(q)(Str.toLowerCase(w.name)) || Str.includes(q)(Str.toLowerCase(w.slug)),
    );
  },
);

export const roleLabelKey = (role: Role): RoleLabelKey => `enum.role.${role}`;
