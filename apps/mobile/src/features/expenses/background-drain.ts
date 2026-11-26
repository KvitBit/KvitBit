import { idempotencyHeaders, UiError } from "@kvitbit/ui-port/api";
import { apiOrigin } from "../../config/env";
import type { Transfer } from "../../platform/transfer";
import { type ApiRunner, credentialsFor, makeApiRunner } from "../../runtime/api-runtime";
import { type AuthFetch, makeAuthFetch } from "../../session/auth-http";
import { readSessionUser } from "../../session/session-user";
import { tokenStore } from "../../session/token-store";
import { type CaptureAccess, type CaptureNetwork, mayCapture } from "./capture-queue";
import { captureQueue } from "./capture-queue-instance";
import { decodeExpenseDetail } from "./model";

export interface BackgroundDrainOutcome {
  readonly status: "ok" | "offline" | "signed_out" | "account_changed" | "error";
  readonly drainedWorkspaces: number;
  readonly completedCount: number;
}

export interface BackgroundDrainDeps {
  readonly origin?: string;
  readonly usesBearer?: boolean;
  readonly readToken?: () => Promise<string | null>;
  readonly authFetch?: (origin: string, getToken: () => string | null) => AuthFetch;
  readonly createApi?: (
    origin: string,
    token: string | null,
  ) => ApiRunner & { readonly dispose: () => Promise<void> };
  readonly createTransfer?: (origin: string, token: string | null) => Pick<Transfer, "upload">;
  readonly isOnline?: () => Promise<boolean>;
  readonly queue?: Pick<typeof captureQueue, "drain">;
}

async function defaultIsOnline(): Promise<boolean> {
  try {
    const { getNetworkStateAsync } = await import("expo-network");
    const state = await getNetworkStateAsync();
    return state.isConnected !== false && state.isInternetReachable !== false;
  } catch {
    return true;
  }
}

export async function runBackgroundCaptureDrain(
  deps: BackgroundDrainDeps = {},
): Promise<BackgroundDrainOutcome> {
  const origin = deps.origin ?? apiOrigin();
  const usesBearer = deps.usesBearer ?? tokenStore.usesBearer;
  const readToken = deps.readToken ?? (() => tokenStore.read());
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const queue = deps.queue ?? captureQueue;

  if (!(await isOnline())) {
    return { status: "offline", drainedWorkspaces: 0, completedCount: 0 };
  }

  const token = usesBearer ? await readToken().catch(() => null) : null;
  if (usesBearer && token === null) {
    return { status: "signed_out", drainedWorkspaces: 0, completedCount: 0 };
  }

  const auth = (deps.authFetch ?? makeAuthFetch)(origin, () => token);
  let sessionResponse: Awaited<ReturnType<AuthFetch>>;
  try {
    sessionResponse = await auth("/get-session");
  } catch {
    return { status: "offline", drainedWorkspaces: 0, completedCount: 0 };
  }
  const user = sessionResponse.ok ? readSessionUser(sessionResponse.body) : null;
  if (user === null) {
    return { status: "signed_out", drainedWorkspaces: 0, completedCount: 0 };
  }

  let authorized = true;
  async function verifyBearer(): Promise<boolean> {
    if (!authorized) return false;
    if (!usesBearer) return true;
    const current = await readToken().catch(() => null);
    if (current !== token) {
      authorized = false;
      return false;
    }
    return true;
  }

  if (!(await verifyBearer())) {
    return { status: "account_changed", drainedWorkspaces: 0, completedCount: 0 };
  }

  const api = (
    deps.createApi ??
    ((baseOrigin, bearerToken) =>
      makeApiRunner(baseOrigin, credentialsFor(bearerToken), () => "en"))
  )(origin, token);
  const transfer =
    deps.createTransfer !== undefined
      ? deps.createTransfer(origin, token)
      : (await import("../../platform/transfer/transfer")).makeTransfer({
          origin,
          credentials: credentialsFor(token),
        });

  let drainedWorkspaces = 0;
  let completedCount = 0;

  try {
    const workspacesResult = await api.run((client) => client.myWorkspaces.listMine());
    if (workspacesResult._tag !== "Ok") {
      return {
        status: workspacesResult.error._tag === "Unauthorized" ? "signed_out" : "error",
        drainedWorkspaces: 0,
        completedCount: 0,
      };
    }

    const network: CaptureNetwork = {
      isOnline,
      record: async (scope, key, payload) => {
        if (!(await verifyBearer())) return { _tag: "Err", error: UiError.offline };
        const response = await api.run((client) =>
          client.expenses.record({
            params: { workspaceId: scope.workspaceId },
            headers: idempotencyHeaders(key),
            payload,
          }),
        );
        if (response._tag === "Err") return response;
        const { id } = decodeExpenseDetail(response.value);
        return id === ""
          ? { _tag: "Err", error: UiError.unexpected(200) }
          : { _tag: "Ok", value: id };
      },
      upload: async (request) => {
        if (!(await verifyBearer())) return { _tag: "Err", error: UiError.offline };
        return transfer.upload(request);
      },
    };

    for (const workspace of workspacesResult.value) {
      if (!mayCapture(user.id, workspace)) continue;
      if (!(await verifyBearer())) {
        return { status: "account_changed", drainedWorkspaces, completedCount };
      }
      const access: CaptureAccess = {
        scope: {
          principalId: user.id,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
        },
        canWrite: () => authorized && mayCapture(user.id, workspace),
        verifyWrite: verifyBearer,
      };
      const result = await queue.drain(access, network, { reconnect: true, signedIn: true });
      drainedWorkspaces += 1;
      completedCount += result.completed.length;
    }

    return {
      status: authorized ? "ok" : "account_changed",
      drainedWorkspaces,
      completedCount,
    };
  } finally {
    await api.dispose();
  }
}
