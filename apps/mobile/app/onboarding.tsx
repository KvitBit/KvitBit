import { useLocalSearchParams } from "expo-router";
import { OnboardingScreen } from "../src/features/onboarding/onboarding-screen";
import { param } from "../src/navigation/routes";

export default function OnboardingRoute() {
  const params = useLocalSearchParams<{ readonly step?: string | string[] }>();
  const rawStep = param(params.step);
  const parsedStep = rawStep !== undefined ? Number.parseInt(rawStep, 10) : undefined;
  const initialStep =
    parsedStep !== undefined && Number.isFinite(parsedStep) ? parsedStep : undefined;
  return <OnboardingScreen {...(initialStep !== undefined ? { initialStep } : {})} />;
}
