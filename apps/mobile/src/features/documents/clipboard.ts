/** Clipboard helper over expo-clipboard with web navigator fallback. */
import * as Clipboard from "expo-clipboard";

export const copyText = async (value: string): Promise<boolean> => {
  try {
    await Clipboard.setStringAsync(value);
    return true;
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
};
