/**
 * Raw access to Better Auth under `/api/auth` (ui-port-contracts 5.1). The typed `/api/v1`
 * client never covers these routes. Android sends the bearer and picks up a rotated token from
 * `set-auth-token` (Better Auth `bearer` plugin); the PWA sends its cookie.
 */
export interface AuthResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  /** A new session token the server issued (sign in, verify link, passkey). */
  readonly token: string | null;
}

export interface AuthRequest {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export type AuthFetch = (path: string, request?: AuthRequest) => Promise<AuthResponse>;

export const makeAuthFetch =
  (
    origin: string,
    token: () => string | null,
    fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ): AuthFetch =>
  async (path, request = {}) => {
    const url = new URL(`/api/auth${path}`, origin);
    for (const [k, v] of Object.entries(request.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    const bearer = token();
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (request.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers,
      credentials: "include",
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const raw = await response.text();
    let body: unknown = null;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
      token: response.headers.get("set-auth-token"),
    };
  };
