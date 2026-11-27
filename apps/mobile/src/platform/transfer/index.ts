/** Transfer port entry: `useTransfer()` binds the session's origin and credentials. */
import { useMemo } from "react";
import { useApi } from "../../runtime/api-runtime";
import type { Transfer } from "./port";
import { makeTransfer } from "./transfer";

export type { LocalFile, SavedFile, TransferResult } from "./http";
export type { DownloadRequest, Transfer, UploadRequest } from "./port";

export const useTransfer = (): Transfer => {
  const { origin, credentials } = useApi();
  return useMemo(() => makeTransfer({ origin, credentials }), [origin, credentials]);
};
