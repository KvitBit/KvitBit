export async function readReceiptBytes(ref: string, limit: number) {
  const { File } = await import("expo-file-system");
  const file = new File(ref);
  return file.size > limit ? null : file.bytes();
}

export async function saveReceiptBytes(key: string, name: string, bytes: Uint8Array<ArrayBuffer>) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "expense-capture", key);
  directory.create({ idempotent: true, intermediates: true });
  // The multipart uploader uses the last URI segment as the filename.
  const basename = name.replace(/[/\\]/g, "-").trim();
  const file = new File(
    directory,
    basename === "" || basename === "." || basename === ".." ? "receipt" : basename,
  );
  try {
    await file.write(bytes);
    return file.uri;
  } catch (error) {
    directory.delete();
    throw error;
  }
}

export async function removeReceiptBytes(ref: string) {
  const { File } = await import("expo-file-system");
  const directory = new File(ref).parentDirectory;
  if (directory.exists) directory.delete();
}
