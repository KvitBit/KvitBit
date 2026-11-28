import type { ReactNode } from "react";

export function TabsMock({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}

export function RedirectMock() {
  return null;
}
