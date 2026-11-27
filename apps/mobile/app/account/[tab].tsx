import { useLocalSearchParams } from "expo-router";
import { AccountScreen } from "../../src/features/account/account-screen";
import { parseAccountTab } from "../../src/features/account/account-tab";
import { param } from "../../src/navigation/routes";

export default function AccountRoute() {
  const params = useLocalSearchParams<{ readonly tab?: string | string[] }>();
  return <AccountScreen tab={parseAccountTab(param(params.tab))} />;
}
