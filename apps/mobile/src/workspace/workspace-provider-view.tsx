import type { ReactNode } from "react";
import { WorkspaceContext, type WorkspaceContextValue } from "./workspace-context";

export function WorkspaceProvider(props: WorkspaceContextValue & { readonly children: ReactNode }) {
  const { children, ...value } = props;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
