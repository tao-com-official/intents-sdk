import { abortable } from "./abort";
import { AbortedError, ApiKeyAuthError, InvalidParamsError } from "./errors";

/** The production TAO.com authentication service. */
export const DEFAULT_AUTH_BASE_URL = "https://api.tao.com";

/** A TAO.com API key from the partner dashboard. Server-side only: the secret must not reach a browser. */
export interface ApiKeyOptions {
  /** Key ID (a UUID). */
  apiKey: string;
  /** The key's secret, shown once when the key was created. */
  apiSecret: string;
  /** Origin of the auth service. Default `https://api.tao.com`; `https://api.dev.tao.com` for testnet. Must be HTTPS. */
  authBaseUrl?: string;
}

/** Bearer tokens for the Quoter, from an API key. */
export interface ApiKeyTokenSource {
  /** A valid token: cached until 30 s before it expires, otherwise one login shared by every caller. */
  getToken(signal?: AbortSignal): Promise<string>;
  /** Forget the cached token (the Quoter refused it), so the next call logs in again. */
  invalidate(): void;
}

const EXPIRY_BUFFER_MS = 30_000;
const LOGIN_TIMEOUT_MS = 15_000;

/**
 * A cached access token for the key (`POST /auth` with the key and secret). `nowMs` is the client's clock in
 * milliseconds. The key and secret go only to `authBaseUrl`, over HTTPS.
 */
export function createApiKeyTokenSource(
  options: ApiKeyOptions,
  fetchFn: typeof fetch,
  nowMs: () => number,
): ApiKeyTokenSource {
  if (!options.apiKey || !options.apiSecret) throw new InvalidParamsError("`apiKey.apiKey` and `apiKey.apiSecret` are required.");
  if (isBrowser()) {
    throw new InvalidParamsError(
      "`apiKey` works on a server only: in a browser the API secret is visible to your users. Get the token from your own backend and pass it as `auth`.",
    );
  }
  const base = authOrigin(options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL);
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const renew = async (): Promise<string> => {
    const issued = await login(base, options, fetchFn);
    cached = { token: issued.token, expiresAt: nowMs() + issued.expiresIn * 1000 };
    return issued.token;
  };

  return {
    getToken(signal) {
      if (signal?.aborted) return Promise.reject(new AbortedError());
      if (cached !== undefined && cached.expiresAt - nowMs() > EXPIRY_BUFFER_MS) return Promise.resolve(cached.token);
      // A failed login isn't cached: `inFlight` clears either way, and `cached` is only set on success.
      inFlight ??= renew().finally(() => {
        inFlight = undefined;
      });
      return abortable(inFlight, signal);
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/** `POST /auth` with the key, with its own timeout. */
async function login(
  base: string,
  options: ApiKeyOptions,
  fetchFn: typeof fetch,
): Promise<{ token: string; expiresIn: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(`${base}/auth`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ type: "API_KEY", username: options.apiKey, password: options.apiSecret }),
      signal: controller.signal,
    });
    text = await response.text().catch(() => "");
  } catch (cause) {
    const what = controller.signal.aborted ? "timed out" : "couldn't be reached";
    throw new ApiKeyAuthError(`The TAO.com auth service ${what} (POST /auth).`, { cause });
  } finally {
    clearTimeout(timer);
  }
  const body = parseObject(text);
  if (!response.ok || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    const reason = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    throw new ApiKeyAuthError(`POST /auth was refused (HTTP ${response.status})${reason}`, { status: response.status });
  }
  return { token: body.access_token, expiresIn: body.expires_in };
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The auth service origin: HTTPS (plain HTTP only to this machine), no path, query or credentials. */
function authOrigin(authBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(authBaseUrl);
  } catch {
    throw new InvalidParamsError("`apiKey.authBaseUrl` must be an absolute URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new InvalidParamsError("`apiKey.authBaseUrl` must use https (http is allowed for localhost only).");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new InvalidParamsError("`apiKey.authBaseUrl` must be an origin, such as https://api.tao.com.");
  }
  return url.origin;
}

/** Client code that ships to users: a browser page or worker, React Native, or a browser-like test environment. */
function isBrowser(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown; importScripts?: unknown; navigator?: { product?: unknown } };
  const page = typeof scope.window === "object" && scope.window !== null && typeof scope.document === "object";
  return page || typeof scope.importScripts === "function" || scope.navigator?.product === "ReactNative";
}
