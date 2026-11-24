import { useLocalSearchParams } from "expo-router";
import { type AuthLinkKind, AuthLinkScreen } from "../../../src/features/auth/auth-link-screen";
import { param } from "../../../src/navigation/routes";

const parseKind = (raw: string | undefined): AuthLinkKind =>
  raw === "verify" || raw === "magic" || raw === "reset" ? raw : "verify";

export default function AuthLinkRoute() {
  const params = useLocalSearchParams<{
    readonly kind?: string | string[];
    readonly token?: string | string[];
  }>();
  return <AuthLinkScreen kind={parseKind(param(params.kind))} token={param(params.token) ?? ""} />;
}
