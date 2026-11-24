/**
 * Blob access for web transfers. Android files are `file://` URIs read by `expo-file-system`,
 * so there is no Blob store on native; the web build resolves `blob-store.web.ts`.
 */
export const blobOf = async (_ref: string): Promise<Blob | null> => null;
export const putBlob = async (_key: string, _blob: Blob): Promise<string> => {
  throw new Error("blob-store is web only");
};
export const deleteBlob = async (_ref: string): Promise<void> => undefined;
