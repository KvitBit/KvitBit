import { useLocalSearchParams } from "expo-router";
import { ResetPasswordScreen } from "../src/features/auth/reset-password-screen";
import { param } from "../src/navigation/routes";

export default function ResetPasswordRoute() {
  const params = useLocalSearchParams<{ readonly token?: string | string[] }>();
  const token = param(params.token);
  return <ResetPasswordScreen {...(token !== undefined ? { token } : {})} />;
}
