/**
 * Shell overlay (ui-port-contracts 2.5): snackbar toasts and confirmation dialogs, hosted once in
 * the root layout and reached through `useOverlay`.
 */

import * as Effect from "effect/Effect";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { forkMobileEffect, runMobileEffect } from "../runtime/request-intent";
import { useTheme } from "../theme/theme-provider";
import { Button } from "./button";
import { type ConfirmRequest, type Overlay, OverlayContext } from "./overlay-context";
import { Text } from "./text";

interface ToastState {
  readonly id: number;
  readonly text: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

export function OverlayProvider(props: { readonly children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<
    (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  >(null);
  const seq = useRef(0);
  const showToast = useCallback<Overlay["toast"]>((text, action) => {
    const id = ++seq.current;
    setToast(action === undefined ? { id, text } : { id, text, action });
    forkMobileEffect(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => setToast((current) => (current?.id === id ? null : current))),
        ),
      ),
    );
  }, []);
  const confirm = useCallback<Overlay["confirm"]>(
    (request) =>
      runMobileEffect(
        Effect.callback<boolean>((resume) =>
          setDialog({ ...request, resolve: (ok) => resume(Effect.succeed(ok)) }),
        ),
      ),
    [],
  );
  const value = useMemo(() => ({ toast: showToast, confirm }), [showToast, confirm]);
  const close = (ok: boolean) => {
    dialog?.resolve(ok);
    setDialog(null);
  };
  const c = theme.colors;
  return (
    <OverlayContext.Provider value={value}>
      {props.children}
      {toast === null ? null : (
        <View
          accessibilityLiveRegion="polite"
          className="absolute right-4 left-4 flex-row items-center gap-3 rounded-control bg-inverse-surface p-4"
          style={{ bottom: insets.bottom + 88 }}
        >
          <Text variant="bodyMedium" color="inverseOnSurface" className="flex-1">
            {toast.text}
          </Text>
          {toast.action === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                toast.action?.onPress();
                setToast(null);
              }}
            >
              <Text variant="labelLarge" color="inversePrimary">
                {toast.action.label}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      <Modal
        transparent
        visible={dialog !== null}
        animationType="fade"
        onRequestClose={() => close(false)}
      >
        <View
          className="flex-1 items-center justify-center p-6"
          style={{ backgroundColor: `${c.scrim}66` }}
        >
          <View
            accessibilityRole="alert"
            className="w-full max-w-[560px] gap-4 bg-surface-container-high p-6"
            style={{ borderRadius: theme.shape.panel + 12 }}
          >
            <Text variant="headlineSmall">{dialog?.title ?? ""}</Text>
            {dialog?.body === undefined ? null : (
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {dialog.body}
              </Text>
            )}
            <View className="flex-row justify-end gap-2">
              <Button kind="text" label={dialog?.cancelLabel ?? ""} onPress={() => close(false)} />
              <Button
                kind={dialog?.destructive === true ? "danger" : "filled"}
                label={dialog?.confirmLabel ?? ""}
                onPress={() => close(true)}
              />
            </View>
          </View>
        </View>
      </Modal>
    </OverlayContext.Provider>
  );
}
