import { idempotencyHeaders, UiError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { apiOrigin } from "../../config/env";
import type { Transfer } from "../../platform/transfer";
import { type ApiRunner, credentialsFor, makeApiRunner } from "../../runtime/api-runtime";
import { fromMobilePromise } from "../../runtime/request-intent";
import { type AuthFetch, makeAuthFetch } from "../../session/auth-http";
import { readSessionUser } from "../../session/session-user";
import { tokenStore } from "../../session/token-store";
import { runFeatureEffect } from "../ui-effect";
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

const defaultIsOnline = Effect.fn("BackgroundCapture.isOnline")(
  function* () {
    const { getNetworkStateAsync } = yield* fromMobilePromise(() => import("expo-network"));
    const state = yield* fromMobilePromise(getNetworkStateAsync);
    return state.isConnected !== false && state.isInternetReachable !== false;
  },
  Effect.orElseSucceed(() => true),
);

const drainInBackground = Effect.fn("BackgroundCapture.drain")(function* (
  deps: BackgroundDrainDeps = {},
): Effect.fn.Return<BackgroundDrainOutcome, Effect.Error<ReturnType<typeof fromMobilePromise>>> {
  const origin = deps.origin ?? apiOrigin();
  const usesBearer = deps.usesBearer ?? tokenStore.usesBearer;
  const readToken = deps.readToken ?? (() => tokenStore.read());
  const checkNetwork = deps.isOnline;
  const isOnline =
    checkNetwork === undefined ? defaultIsOnline : () => fromMobilePromise(checkNetwork);
  const queue = deps.queue ?? captureQueue;

  if (!(yield* isOnline())) {
    return { status: "offline", drainedWorkspaces: 0, completedCount: 0 };
  }

  const token = usesBearer
    ? yield* fromMobilePromise(readToken).pipe(Effect.orElseSucceed(() => null))
    : null;
  if (usesBearer && token === null) {
    return { status: "signed_out", drainedWorkspaces: 0, completedCount: 0 };
  }

  const auth = (deps.authFetch ?? makeAuthFetch)(origin, () => token);
  const sessionResponse = yield* fromMobilePromise(() => auth("/get-session")).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (sessionResponse === null) {
    return { status: "offline", drainedWorkspaces: 0, completedCount: 0 };
  }
  const user = sessionResponse.ok ? readSessionUser(sessionResponse.body) : null;
  if (user === null) {
    return { status: "signed_out", drainedWorkspaces: 0, completedCount: 0 };
  }

  const authorization = MutableRef.make(true);
  const verifyBearer = Effect.fn("BackgroundCapture.verifyBearer")(function* () {
    if (!MutableRef.get(authorization)) return false;
    if (!usesBearer) return true;
    const current = yield* fromMobilePromise(readToken).pipe(Effect.orElseSucceed(() => null));
    if (current !== token) {
      MutableRef.set(authorization, false);
      return false;
    }
    return true;
  });

  if (!(yield* verifyBearer())) {
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
      : (yield* fromMobilePromise(() => import("../../platform/transfer/transfer"))).makeTransfer({
          origin,
          credentials: credentialsFor(token),
        });

  let drainedWorkspaces = 0;
  let completedCount = 0;

  return yield* Effect.gen(function* (): Effect.fn.Return<
    BackgroundDrainOutcome,
    Effect.Error<ReturnType<typeof fromMobilePromise>>
  > {
    const workspacesResult = yield* fromMobilePromise(() =>
      api.run((client) => client.myWorkspaces.listMine()),
    );
    if (workspacesResult._tag !== "Ok") {
      return {
        status: workspacesResult.error._tag === "Unauthorized" ? "signed_out" : "error",
        drainedWorkspaces: 0,
        completedCount: 0,
      };
    }

    const network: CaptureNetwork = {
      isOnline: () => runFeatureEffect(isOnline()),
      record: (scope, key, payload) =>
        runFeatureEffect(
          Effect.gen(function* () {
            if (!(yield* verifyBearer())) return { _tag: "Err", error: UiError.offline } as const;
            const response = yield* fromMobilePromise(() =>
              api.run((client) =>
                client.expenses.record({
                  params: { workspaceId: scope.workspaceId },
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
            );
            if (response._tag === "Err") return response;
            const expense = decodeExpenseDetail(response.value);
            return expense === null
              ? ({ _tag: "Err", error: UiError.unexpected(200) } as const)
              : ({ _tag: "Ok", value: expense.id } as const);
          }),
        ),
      upload: (request) =>
        runFeatureEffect(
          Effect.gen(function* () {
            if (!(yield* verifyBearer())) return { _tag: "Err", error: UiError.offline } as const;
            return yield* fromMobilePromise(() => transfer.upload(request));
          }),
        ),
    };

    for (const workspace of workspacesResult.value) {
      if (!mayCapture(user.id, workspace)) continue;
      if (!(yield* verifyBearer())) {
        return { status: "account_changed", drainedWorkspaces, completedCount };
      }
      const access: CaptureAccess = {
        scope: {
          principalId: user.id,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
        },
        canWrite: () => MutableRef.get(authorization) && mayCapture(user.id, workspace),
        verifyWrite: () => runFeatureEffect(verifyBearer()),
      };
      const result = yield* fromMobilePromise(() =>
        queue.drain(access, network, { reconnect: true, signedIn: true }),
      );
      drainedWorkspaces += 1;
      completedCount += result.completed.length;
    }

    return {
      status: MutableRef.get(authorization) ? "ok" : "account_changed",
      drainedWorkspaces,
      completedCount,
    };
  }).pipe(
    Effect.ensuring(
      fromMobilePromise(() => api.dispose()).pipe(Effect.catch((error) => Effect.die(error.cause))),
    ),
  );
});

export const runBackgroundCaptureDrain = (deps?: BackgroundDrainDeps) =>
  runFeatureEffect(drainInBackground(deps).pipe(Effect.catch((error) => Effect.die(error.cause))));
