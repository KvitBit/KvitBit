import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { hrefOf } from "../src/navigation/routes";
import { useRemote } from "../src/runtime/api-runtime";
import { useSession } from "../src/session/session-provider";
import { Loading } from "../src/ui/surface";
import { lastWorkspace, pickWorkspace } from "../src/workspace/last-workspace";

/** Launch: sign in, onboard (no Workspace yet) or open the last Workspace's dashboard. */
export default function Index() {
  const session = useSession();
  const signedIn = session.state.status === "signed-in";
  const workspaces = useRemote(signedIn ? (api) => api.myWorkspaces.listMine() : null, [signedIn]);
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void lastWorkspace.read().then(setRemembered);
  }, []);
  if (!signedIn) return <Redirect href="/sign-in" />;
  if (workspaces.state._tag !== "Ready" || remembered === undefined) return <Loading />;
  const target = pickWorkspace(workspaces.state.value, remembered);
  if (target === null) return <Redirect href="/onboarding" />;
  return <Redirect href={hrefOf({ _tag: "Dashboard", ws: target.slug }) as never} />;
}
