import { useLocalSearchParams } from "expo-router";
import { SignInScreen } from "../src/features/auth/sign-in-screen";
import { param } from "../src/navigation/routes";

export default function SignInRoute() {
  const params = useLocalSearchParams<{
    readonly returnTo?: string | string[];
    readonly verified?: string | string[];
  }>();
  const returnTo = param(params.returnTo);
  return (
    <SignInScreen
      {...(returnTo !== undefined ? { returnTo } : {})}
      emailVerified={param(params.verified) === "1"}
    />
  );
}
