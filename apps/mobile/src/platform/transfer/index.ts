/** Transfer port entry: `useTransfer()` binds the session's origin and credentials. */
import { useMemo } from "react";
import { useApi } from "../../runtime/api-runtime";
import type { Transfer } from "./port";
import { makeTransfer } from "./transfer";

export {
  apiUrl,
  authHeaders,
  errorFromResponse,
  type LocalFile,
  type SavedFile,
  type TransferResult,
  type TransferTarget,
} from "./http";
export type { DownloadRequest, Transfer, UploadRequest } from "./port";
export { makeTransfer };

export const useTransfer = (): Transfer => {
  const { origin, credentials } = useApi();
  return useMemo(() => makeTransfer({ origin, credentials }), [origin, credentials]);
};
