import type { CaptureStorage } from "./capture-storage-port";

const storage = async () => (await import("@react-native-async-storage/async-storage")).default;
const keyFor = (scope: string) => `expense-capture:v1:${scope}`;

export const captureStorage: CaptureStorage = {
  load: async (scope) => (await storage()).getItem(keyFor(scope)),
  save: async (scope, value) => (await storage()).setItem(keyFor(scope), value),
  lock: async (_scope, work) => work(),
};
