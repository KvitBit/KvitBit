/** Remembers the last opened Workspace, so launch opens it again (KeyValue cache, spec 5.4). */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "kvitbit.last-workspace";

export const lastWorkspace = {
  read: (): Promise<string | null> => AsyncStorage.getItem(KEY).catch(() => null),
  write: (slug: string): Promise<void> => AsyncStorage.setItem(KEY, slug).catch(() => undefined),
};

/** The Workspace to open: the remembered one while still a member, else the first open one. */
export const pickWorkspace = <W extends { readonly slug: string; readonly closed: boolean }>(
  workspaces: ReadonlyArray<W>,
  remembered: string | null,
): W | null =>
  workspaces.find((w) => w.slug === remembered) ??
  workspaces.find((w) => !w.closed) ??
  workspaces[0] ??
  null;
