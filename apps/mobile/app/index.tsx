import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { onboardingStore } from "../src/features/onboarding/onboarding-persistence";
import { hrefOf } from "../src/navigation/routes";
import { useRemote } from "../src/runtime/api-runtime";
import { useSession } from "../src/session/session-provider";
import { Loading } from "../src/ui/surface";
import { lastWorkspace, pickWorkspace } from "../src/workspace/last-workspace";

/** Launch: sign in, onboard (no Workspace yet or incomplete onboarding) or open the last Workspace's dashboard. */
export default function Index() {
  const session = useSession();
  const signedIn = session.state.status === "signed-in";
  const userId = session.state.status === "signed-in" ? session.state.user.id : null;
  const onboardingScopeKey = userId === null ? null : `${session.origin}\0${userId}`;
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);
  const [pendingOnboarding, setPendingOnboarding] = useState<
    { readonly key: string; readonly pending: boolean } | undefined
  >(undefined);
  const onboardingChecked =
    onboardingScopeKey !== null && pendingOnboarding?.key === onboardingScopeKey;
  const shouldLoadWorkspaces = signedIn && onboardingChecked && !pendingOnboarding.pending;
  const workspaces = useRemote(shouldLoadWorkspaces ? (api) => api.myWorkspaces.listMine() : null, [
    shouldLoadWorkspaces,
  ]);

  useEffect(() => {
    void lastWorkspace.read().then(setRemembered);
  }, []);

  useEffect(() => {
    if (userId === null || onboardingScopeKey === null) {
      setPendingOnboarding(undefined);
      return;
    }
    let cancelled = false;
    void onboardingStore.read(session.origin, userId).then((record) => {
      if (!cancelled) setPendingOnboarding({ key: onboardingScopeKey, pending: record !== null });
    });
    return () => {
      cancelled = true;
    };
  }, [session.origin, userId, onboardingScopeKey]);

  if (!signedIn) return <Redirect href="/sign-in" />;
  if (pendingOnboarding === undefined || pendingOnboarding.key !== onboardingScopeKey) {
    return <Loading />;
  }
  if (pendingOnboarding.pending) return <Redirect href="/onboarding" />;
  if (workspaces.state._tag !== "Ready" || remembered === undefined) return <Loading />;
  const target = pickWorkspace(workspaces.state.value, remembered);
  if (target === null) return <Redirect href="/onboarding" />;
  return <Redirect href={hrefOf({ _tag: "Dashboard", ws: target.slug }) as never} />;
}
