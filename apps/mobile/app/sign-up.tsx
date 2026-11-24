import { useLocalSearchParams } from "expo-router";
import { SignUpScreen } from "../src/features/auth/sign-up-screen";
import { param } from "../src/navigation/routes";

export default function SignUpRoute() {
  const params = useLocalSearchParams<{
    readonly invitation?: string | string[];
    readonly email?: string | string[];
  }>();
  const invitation = param(params.invitation);
  const lockedEmail = param(params.email);
  return (
    <SignUpScreen
      {...(invitation !== undefined ? { invitation } : {})}
      {...(lockedEmail !== undefined ? { lockedEmail } : {})}
    />
  );
}
