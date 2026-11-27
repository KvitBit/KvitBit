/**
 * Shell overlay (ui-port-contracts 2.5): snackbar toasts and confirmation dialogs, hosted once in
 * the root layout and reached through `useOverlay`.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme-provider";
import { Button } from "./button";
import { Text } from "./text";

export interface ConfirmRequest {
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive?: boolean;
}

export interface Overlay {
  readonly toast: (
    text: string,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => void;
  /** Resolves true when the user confirms. */
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
}

const OverlayContext = createContext<Overlay | null>(null);

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
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 5000);
  }, []);
  const confirm = useCallback<Overlay["confirm"]>(
    (request) => new Promise<boolean>((resolve) => setDialog({ ...request, resolve })),
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
                kind={dialog?.destructive ? "danger" : "filled"}
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

/** The bare context, for tests that record toasts and answer confirmations. */
export const OverlayContextProvider = OverlayContext.Provider;

export const useOverlay = (): Overlay => {
  const value = useContext(OverlayContext);
  if (value === null) throw new Error("useOverlay needs an OverlayProvider");
  return value;
};
