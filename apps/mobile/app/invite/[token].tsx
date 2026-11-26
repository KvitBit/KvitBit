import { useLocalSearchParams } from "expo-router";
import { InviteScreen } from "../../src/features/auth/invite-screen";
import { param } from "../../src/navigation/routes";

export default function InviteRoute() {
  const params = useLocalSearchParams<{ readonly token?: string | string[] }>();
  return <InviteScreen token={param(params.token) ?? ""} />;
}
