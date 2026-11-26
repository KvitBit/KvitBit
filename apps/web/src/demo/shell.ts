/**
 * Shell fixtures for demo mode: one signed-in user who owns two workspaces. Other groups import
 * DEMO_WORKSPACE / DEMO_USER to key their fixtures.
 */
import { WorkspaceSummary } from "@kvitbit/domain";
import { Schema } from "effect";
import type { DemoRoute } from "./router";

/** A deterministic UUIDv7-shaped id: `demoId(1)` -> 0193a000-0000-7000-8000-000000000001. */
export const demoId = (n: number): string =>
  `0193a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export const DEMO_USER = {
  id: demoId(1),
  email: "jana.novakova@example.cz",
  name: "Jana Nováková",
  emailVerified: true,
} as const;

const summaries = Schema.decodeUnknownSync(Schema.Array(WorkspaceSummary))([
  {
    id: demoId(100),
    slug: "novak-design",
    name: "Novák Design s.r.o.",
    role: "owner",
    memberCount: 3,
    taxRegime: "vat_payer",
    closed: false,
  },
  {
    id: demoId(101),
    slug: "jana-osvc",
    name: "Jana Nováková (OSVČ)",
    role: "owner",
    memberCount: 1,
    taxRegime: "non_vat_payer",
    closed: false,
  },
]);

export const DEMO_WORKSPACES: ReadonlyArray<WorkspaceSummary> = summaries;
// biome-ignore lint/style/noNonNullAssertion: fixture array is non-empty by construction
export const DEMO_WORKSPACE: WorkspaceSummary = summaries[0]!;

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
    respond: () => Schema.encodeSync(Schema.Array(WorkspaceSummary))(DEMO_WORKSPACES),
  },
];
