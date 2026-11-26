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
import { useOverlay } from "../../ui";
import { importSharedReceipts } from "./capture-share";
import { captureQueue, useCaptureAccess, useCaptureNetwork } from "./use-expense-capture";

export function ExpenseCaptureRuntime() {
  const { current, all } = useCaptureAccess();
  const network = useCaptureNetwork();
  const { t, local } = useI18n();
  const { toast } = useOverlay();
  const pathname = usePathname();
  const { captureId } = useGlobalSearchParams<{ captureId?: string }>();
  const active = useRef({ pathname, captureId, t, local, toast });
  active.current = { pathname, captureId, t, local, toast };

  useEffect(() => {
    if (all.length === 0) return;
    let disposed = false;
    let running = false;
    let requested = false;
    let reconnect = false;
    let signedIn = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function drain(online = false) {
      if (disposed) return;
      reconnect ||= online;
      if (running) {
        requested = true;
        return;
      }
      clearTimeout(timer);
      running = true;
      const options = { reconnect, signedIn };
      reconnect = false;
      signedIn = false;
      void Promise.allSettled(all.map((access) => captureQueue.drain(access, network, options)))
        .then((results) => {
          if (disposed) return;
          let nextAt = Infinity;
          for (const result of results) {
            if (result.status === "rejected") continue;
            nextAt = Math.min(nextAt, result.value.nextAt ?? Infinity);
            for (const job of result.value.completed) {
              const { toast, t } = active.current;
              const rejected = job.files.some(({ result: file }) => file?.kind === "rejected");
              const id = job.expenseId;
              if (id === null) continue;
              toast(t(rejected ? "error.invalid" : "common.toast.saved"), {
                label: t("common.action.open"),
                onPress: () =>
                  navigate({ _tag: "Expense", ws: job.scope.workspaceSlug, id, mode: "edit" }),
              });
            }
          }
          if (nextAt !== Infinity) timer = setTimeout(drain, Math.max(0, nextAt - Date.now()));
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
      if (state.isConnected && state.isInternetReachable !== false) drain(true);
    });
    drain();

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      app.remove();
      connection.remove();
    };
  }, [all, network]);

  useEffect(() => {
    const access = current;
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
      void importSharedReceipts(access, captureQueue, {
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
          router.push(`${href}?captureId=${encodeURIComponent(staged.job.key)}` as never);
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
  }, [current]);

  return null;
}
