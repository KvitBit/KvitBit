import { useLocalSearchParams } from "expo-router";
import { SettingsScreen } from "../../../../src/features/settings/settings-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const { section } = useLocalSearchParams<{ section: string }>();
  return <SettingsScreen sectionParam={param(section)} />;
}
