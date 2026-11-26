/** Validates an Expo Router destination, including links captured with Expo's /app base. */
export const safeReturnTo = (raw: string | undefined): string | null => {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, "https://app.invalid");
    const path = decodeURIComponent(raw.split(/[?#]/, 1)[0] ?? "");
    if (url.origin !== "https://app.invalid" || path.startsWith("//") || path.includes("\\"))
      return null;
    if (Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      return null;
    if (path.split("/").some((segment) => segment === ".." || segment === ".")) return null;
    const pathname = url.pathname.startsWith("/app/")
      ? url.pathname.slice("/app".length)
      : url.pathname;
    if (decodeURIComponent(pathname).startsWith("//")) return null;
    return `${pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};
