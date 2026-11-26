/** All demo handlers. Shell-level fixtures (session, workspaces) live in ./shell. */
import { routes as documents } from "./documents";
import { routes as publicRoutes } from "./public";
import { routes as records } from "./records";
import type { DemoRoute } from "./router";
import { routes as settings } from "./settings";
import { routes as shell } from "./shell";

export const demoRoutes: ReadonlyArray<DemoRoute> = [
  ...shell,
  ...publicRoutes,
  ...documents,
  ...records,
  ...settings,
];

export const demoEnabled = (): boolean => import.meta.env.VITE_KVITBIT_DEMO === "1";
