import type { SettingsSection } from "@kvitbit/ui-port/view-models";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { Banner, EmptyState, Screen } from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { ApiKeysSection } from "./api-keys-section";
import { BankAccountsSection } from "./bank-accounts-section";
import { BrandingSection } from "./branding-section";
import { ConnectedAppsSection } from "./connected-apps-section";
import { DangerZoneSection } from "./danger-zone-section";
import { DocumentDefaultsSection } from "./document-defaults-section";
import { IssuingEntitySection } from "./issuing-entity-section";
import { NumberingSection } from "./numbering-section";
import { RemindersSection } from "./reminders-section";
import { TaxRegimeSection } from "./tax-regime-section";
import { TeamSection } from "./team-section";
import { parseSettingsSection, sectionTitleKey } from "./workspace-data";

const renderSection = (section: SettingsSection) => {
  switch (section) {
    case "issuingEntity":
      return <IssuingEntitySection />;
    case "taxRegime":
      return <TaxRegimeSection />;
    case "bankAccounts":
      return <BankAccountsSection />;
    case "branding":
      return <BrandingSection />;
    case "numbering":
      return <NumberingSection />;
    case "documentDefaults":
      return <DocumentDefaultsSection />;
    case "reminders":
      return <RemindersSection />;
    case "team":
      return <TeamSection />;
    case "apiKeys":
      return <ApiKeysSection />;
    case "connectedApps":
      return <ConnectedAppsSection />;
    case "dangerZone":
      return <DangerZoneSection />;
  }
};

/** Dispatcher for `/w/[ws]/settings/[section]`. */
export function SettingsScreen(props: { readonly sectionParam: string | undefined }) {
  const { workspace } = useWorkspace();
  const { t, local } = useI18n();
  const section = parseSettingsSection(props.sectionParam);

  if (section === null) {
    return (
      <Screen
        title={t("settings.title")}
        back={() => navigate({ _tag: "More", ws: workspace.slug }, { replace: true })}
      >
        <EmptyState
          title={local({ cs: "Sekce nastavení nenalezena", en: "Settings section not found" })}
          action={{
            label: t("common.action.back"),
            onPress: () => navigate({ _tag: "More", ws: workspace.slug }, { replace: true }),
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen title={t(sectionTitleKey(section))} back>
      {workspace.closed ? <Banner text={t("shell.closedWorkspace")} tone="warning" /> : null}
      {renderSection(section)}
    </Screen>
  );
}
