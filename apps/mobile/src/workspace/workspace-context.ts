import type { WorkspaceSummary } from "@kvitbit/domain/contract";
import * as Option from "effect/Option";
import { createContext, useContext } from "react";

export interface WorkspaceContextValue {
  /** The active Workspace (from the `w/[ws]` slug). API calls use its id. */
  readonly workspace: WorkspaceSummary;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  /** Re-reads the Workspace list (after a rename, close or join). */
  readonly reload: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const useWorkspace = (): WorkspaceContextValue => {
  const value = useContext(WorkspaceContext);
  return Option.getOrThrowWith(
    Option.fromNullOr(value),
    () => new Error("useWorkspace needs a WorkspaceProvider (under app/w/[ws])"),
  );
};
