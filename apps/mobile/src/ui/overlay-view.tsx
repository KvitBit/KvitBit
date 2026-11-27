/**
 * Shell overlay (ui-port-contracts 2.5): snackbar toasts and confirmation dialogs, hosted once in
 * the root layout and reached through `useOverlay`.
 */

import * as Effect from "effect/Effect";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { forkMobileEffect, runMobileEffect } from "../runtime/request-intent";
import { useTheme } from "../theme/theme-provider";
import { Button } from "./button";
import { type ConfirmRequest, type Overlay, OverlayContext } from "./overlay-context";
import { Text } from "./text";
import { space } from "./tokens";

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
          style={[
            styles.toast,
            {
              bottom: insets.bottom + 88,
              backgroundColor: c.inverseSurface,
              borderRadius: theme.shape.control,
            },
          ]}
        >
          <Text variant="bodyMedium" style={{ color: c.inverseOnSurface, flex: 1 }}>
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
              <Text variant="labelLarge" style={{ color: c.inversePrimary }}>
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
        <View style={[styles.scrim, { backgroundColor: `${c.scrim}66` }]}>
          <View
            accessibilityRole="alert"
            style={[
              styles.dialog,
              { backgroundColor: c.surfaceContainerHigh, borderRadius: theme.shape.panel + 12 },
            ]}
          >
            <Text variant="headlineSmall">{dialog?.title ?? ""}</Text>
            {dialog?.body === undefined ? null : (
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {dialog.body}
              </Text>
            )}
            <View style={styles.dialogActions}>
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

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  scrim: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  dialog: { width: "100%", maxWidth: 560, padding: space.xl, gap: space.lg },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
});
