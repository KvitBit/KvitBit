export const BACKGROUND_CAPTURE_DRAIN_TASK = "kvitbit.expense-capture.drain";
export const BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES = 15;

export async function registerBackgroundCaptureDrain(): Promise<boolean> {
  return false;
}

export async function unregisterBackgroundCaptureDrain(): Promise<boolean> {
  return false;
}
