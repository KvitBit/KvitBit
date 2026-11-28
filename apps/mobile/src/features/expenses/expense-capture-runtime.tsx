import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { addNetworkStateListener } from "expo-network";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { hrefOf, navigate } from "../../navigation/routes";
import {
  acknowledgeSharedFiles,
  listPendingSharedFiles,
  subscribeSharedFiles,
} from "../../platform/capture/share-intent";
import { fromMobilePromise } from "../../runtime/request-intent";
import { useOverlay } from "../../ui";
import { runFeatureCallback, runFeatureEffect } from "../ui-effect";
import { captureQueue } from "./capture-queue-instance";
import { importSharedReceipts } from "./capture-share";
import { useCaptureAccess, useCaptureNetwork } from "./use-expense-capture";

export function ExpenseCaptureRuntime() {
  const { current: access, all } = useCaptureAccess();
  const network = useCaptureNetwork();
  const i18n = useI18n();
  const overlay = useOverlay();
  const route = useGlobalSearchParams<{ captureId?: string }>();
  const latest = {
    pathname: usePathname(),
    captureId: route.captureId,
    t: i18n.t,
    local: i18n.local,
    toast: overlay.toast,
  };
  const active = useRef(latest);
  active.current = latest;

  useEffect(() => {
    if (all.length === 0) return;
    let disposed = false;
    let running = false;
    let requested = false;
    let reconnect = false;
    let signedIn = true;
    let cancelRetry: (() => void) | undefined;

    function drain(online = false) {
      if (disposed) return;
      reconnect ||= online;
      if (running) {
        requested = true;
        return;
      }
      cancelRetry?.();
      running = true;
      const options = { reconnect, signedIn };
      reconnect = false;
      signedIn = false;
      runFeatureEffect(
        Effect.forEach(
          all,
          (candidate) =>
            fromMobilePromise(() => captureQueue.drain(candidate, network, options)).pipe(
              Effect.result,
            ),
          {
            concurrency: "unbounded",
          },
        ),
      )
        .then((results) => {
          if (disposed) return;
          let nextAt = Number.POSITIVE_INFINITY;
          for (const result of results) {
            if (Result.isFailure(result)) continue;
            nextAt = Math.min(nextAt, result.success.nextAt ?? Number.POSITIVE_INFINITY);
            for (const job of result.success.completed) {
              const { toast, t } = active.current;
              const rejected = Arr.some(job.files, ({ result: file }) => file?.kind === "rejected");
              const id = job.expenseId;
              if (id === null) continue;
              toast(t(rejected ? "error.invalid" : "common.toast.saved"), {
                label: t("common.action.open"),
                onPress: () =>
                  navigate({ _tag: "Expense", ws: job.scope.workspaceSlug, id, mode: "edit" }),
              });
            }
          }
          if (nextAt !== Number.POSITIVE_INFINITY) {
            cancelRetry = runFeatureCallback({
              effect: Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => Effect.sleep(Math.max(0, nextAt - now))),
              ),
              onExit: (exit) => {
                if (Exit.isSuccess(exit)) {
                  cancelRetry = undefined;
                  drain();
                }
              },
            });
          }
        })
        .finally(() => {
          running = false;
          if (requested) {
            requested = false;
            drain();
          }
        });
    }

    const unsubscribe = captureQueue.subscribe(() => drain());
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") drain();
    });
    const connection = addNetworkStateListener((state) => {
      if (state.isConnected === true && state.isInternetReachable !== false) drain(true);
    });
    drain();

    return () => {
      disposed = true;
      cancelRetry?.();
      unsubscribe();
      app.remove();
      connection.remove();
    };
  }, [all, network]);

  useEffect(() => {
    if (access === null) return;
    let disposed = false;
    let running = false;
    let requested = false;
    const receive = () => {
      if (disposed) return;
      if (running) {
        requested = true;
        return;
      }
      running = true;
      importSharedReceipts(access, captureQueue, {
        list: listPendingSharedFiles,
        acknowledge: acknowledgeSharedFiles,
      })
        .then((staged) => {
          if (disposed || staged === null || !access.canWrite()) return;
          const { pathname, captureId, toast, t, local } = active.current;
          for (const issue of staged.issues) {
            toast(
              issue === "too_large"
                ? local({ cs: "Soubor je větší než 20 MB.", en: "File exceeds 20 MB limit." })
                : issue === "unsupported_type"
                  ? t("expenses.attachmentViewer.allowedTypes", { types: "PDF, JPEG, PNG, HEIC" })
                  : t("error.unknown"),
            );
          }
          if (staged.job === undefined) return;
          const href = hrefOf({ _tag: "ExpenseCapture", ws: access.scope.workspaceSlug });
          if (pathname === href && captureId === staged.job.key) return;
          router.push(`${href}?captureId=${encodeURIComponent(staged.job.key)}`);
        })
        .catch(() => {
          if (!disposed && access.canWrite())
            active.current.toast(active.current.t("error.unknown"));
        })
        .finally(() => {
          running = false;
          if (requested) {
            requested = false;
            receive();
          }
        });
    };
    const unsubscribe = subscribeSharedFiles(receive);
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") receive();
    });
    receive();
    return () => {
      disposed = true;
      unsubscribe();
      app.remove();
    };
  }, [access]);

  return null;
}
