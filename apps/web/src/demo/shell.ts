/**
 * Shell fixtures for demo mode: one signed-in user who owns two workspaces. Other groups import
 * DEMO_WORKSPACE / DEMO_USER to key their fixtures.
 */

import { WorkspaceId, WorkspaceSlug, type WorkspaceSummary } from "@kvitbit/domain";
import * as Str from "effect/String";
import type { DemoRoute } from "./router";

/** A deterministic UUIDv7-shaped id: `demoId(1)` -> 0193a000-0000-7000-8000-000000000001. */
export const demoId = (n: number): string =>
  `0193a000-0000-7000-8000-${Str.padStart(12, "0")(n.toString(16))}`;

export const DEMO_USER = {
  id: demoId(1),
  email: "jana.novakova@example.cz",
  name: "Jana Nováková",
  emailVerified: true,
} as const;

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: WorkspaceId.make(demoId(100)),
  slug: WorkspaceSlug.make("novak-design"),
  name: "Novák Design s.r.o.",
  role: "owner",
  memberCount: 3,
  taxRegime: "vat_payer",
  closed: false,
};
export const DEMO_WORKSPACES: ReadonlyArray<WorkspaceSummary> = [
  DEMO_WORKSPACE,
  {
    id: WorkspaceId.make(demoId(101)),
    slug: WorkspaceSlug.make("jana-osvc"),
    name: "Jana Nováková (OSVČ)",
    role: "owner",
    memberCount: 1,
    taxRegime: "non_vat_payer",
    closed: false,
  },
];

export const routes: ReadonlyArray<DemoRoute> = [
  {
    method: "GET",
    path: "/api/auth/get-session",
    respond: () => ({ user: DEMO_USER, session: { id: "demo", userId: DEMO_USER.id } }),
  },
  { method: "POST", path: "/api/auth/sign-out", respond: () => ({ success: true }) },
  {
    method: "GET",
    path: "/api/v1/workspaces",
    respond: () => DEMO_WORKSPACES,
  },
];
