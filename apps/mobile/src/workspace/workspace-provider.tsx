import type { WorkspaceSummary } from "@kvitbit/domain/contract";
import { createContext, type ReactNode, useContext } from "react";

export interface WorkspaceContextValue {
  /** The active Workspace (from the `w/[ws]` slug). API calls use its id. */
  readonly workspace: WorkspaceSummary;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  /** Re-reads the Workspace list (after a rename, close or join). */
  readonly reload: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider(props: WorkspaceContextValue & { readonly children: ReactNode }) {
  const { children, ...value } = props;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export const useWorkspace = (): WorkspaceContextValue => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("useWorkspace needs a WorkspaceProvider (under app/w/[ws])");
  return value;
};
