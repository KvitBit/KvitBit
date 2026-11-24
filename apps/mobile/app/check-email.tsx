import { useLocalSearchParams } from "expo-router";
import { CheckEmailScreen } from "../src/features/auth/check-email-screen";
import { param } from "../src/navigation/routes";

export default function CheckEmailRoute() {
  const params = useLocalSearchParams<{ readonly email?: string | string[] }>();
  return <CheckEmailScreen email={param(params.email) ?? ""} />;
}
