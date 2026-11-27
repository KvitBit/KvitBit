/** Remembers the last opened Workspace, so launch opens it again (KeyValue cache, spec 5.4). */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";

const KEY = "kvitbit.last-workspace";

export const lastWorkspace = {
  read: (): Promise<string | null> => AsyncStorage.getItem(KEY).catch(() => null),
  write: (slug: string): Promise<void> => AsyncStorage.setItem(KEY, slug).catch(() => undefined),
};

/** The Workspace to open: the remembered one while still a member, else the first open one. */
interface WorkspaceChoice {
  readonly slug: string;
  readonly closed: boolean;
}

export const pickWorkspace: {
  (
    remembered: string | null,
  ): <W extends WorkspaceChoice>(workspaces: ReadonlyArray<W>) => W | null;
  <W extends WorkspaceChoice>(workspaces: ReadonlyArray<W>, remembered: string | null): W | null;
} = Fn.dual(
  2,
  <W extends WorkspaceChoice>(workspaces: ReadonlyArray<W>, remembered: string | null): W | null =>
    Option.getOrUndefined(EffectArray.findFirst(workspaces, (w) => w.slug === remembered)) ??
    Option.getOrUndefined(EffectArray.findFirst(workspaces, (w) => !w.closed)) ??
    workspaces[0] ??
    null,
);
