import type { Address } from "viem";
import { abortable } from "./abort";
import { AbortedError, InvalidParamsError, QuoterError, type QuoterFailure } from "./errors";
import type { QuoterRoute } from "./swap";
import type { QuoterFees } from "./types";

export interface QuoterRequest {
  originChainId: string;
  destinationChainId: string;
  inputTokenAddress: Address;
  outputTokenAddress: Address;
  inputAmount: string;
  userAddress?: Address;
  recipient?: Address;
  fillDeadline?: number;
  /** Substrate payout leg, sent instead of `recipient`. Coldkey and hotkey are SS58 addresses. */
  subtensor?:
    | { side: "destination" | "source"; operation: "transfer_tao"; recipientColdkey: string; amount?: string }
    | { side: "destination"; operation: "alpha_stake"; netuid: number; delegatorHotkey: string; recipientColdkey: string }
    /** Alpha input: the stake the settler unstakes. `amount` is the alpha in rao; the coldkey owns it. */
    | { side: "source"; operation: "alpha_stake"; netuid: number; delegatorHotkey: string; recipientColdkey: string; amount: string };
}

export interface QuoterResponse {
  quote: {
    validUntil: number;
    preview: {
      inputs: Array<{ asset: string; amount: string; userPaysUsd?: string; subtensorData?: string }>;
      outputs: Array<{ asset: string; amount: string; userReceivesUsd?: string; subtensorData?: string }>;
    };
  };
  fees?: QuoterFees;
  /** Uniswap hop the winning solver priced for a non-USDC input. Absent for USDC or older backends. */
  route?: QuoterRoute;
  /** The origin chain's Intents contract (FullSettler): what the input is approved to. */
  approvalSpender?: string;
}

export interface QuoterClientOptions {
  url: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /** Extra attempts for transient failures (503/504, network errors, solver fan-out failures). */
  retries: number;
  /**
   * Bearer token for the Quoter, read on every attempt (a function gets the caller's signal). Omitted: no
   * `Authorization` header is sent.
   */
  auth?: string | ((signal?: AbortSignal) => string | Promise<string>);
  /** Called when the Quoter answers 401 to a token, before one more attempt with a fresh one. */
  onUnauthorized?: () => void;
}

const RETRY_DELAY_MS = 750;

const MESSAGES: Record<string, string> = {
  SETTLER_PAUSED: "The Intents contract on this route is paused. New intents can't be opened right now.",
  RATE_LIMITED: "Too many quote requests. Wait a moment before requesting another quote.",
  NO_SOLVERS_REGISTERED: "The quote service is temporarily unavailable. Please retry shortly.",
  SETTLER_PAUSE_UNAVAILABLE: "The quote service is temporarily unavailable. Please retry shortly.",
  SOLVER_FANOUT_FAILED: "The quote service failed unexpectedly. Please retry shortly.",
  INVALID_FILL_DEADLINE: "The fill deadline is invalid (it must be in the future and at most 1 day ahead).",
};

export async function requestQuote(
  request: QuoterRequest,
  opts: QuoterClientOptions,
  signal?: AbortSignal,
): Promise<QuoterResponse> {
  let attempt = 0;
  let reauthorized = false;
  for (;;) {
    try {
      return await attemptQuote(request, opts, signal);
    } catch (error) {
      // A revoked or rotated token: drop it and try once more with a fresh one.
      if (error instanceof QuoterError && error.status === 401 && opts.onUnauthorized !== undefined && !reauthorized) {
        reauthorized = true;
        opts.onUnauthorized();
        continue;
      }
      if (!(error instanceof QuoterError) || !error.retryable || error.status === 429 || attempt >= opts.retries) {
        throw error;
      }
      attempt++;
      await sleep(RETRY_DELAY_MS * attempt, signal);
    }
  }
}

async function attemptQuote(
  request: QuoterRequest,
  opts: QuoterClientOptions,
  signal?: AbortSignal,
): Promise<QuoterResponse> {
  if (signal?.aborted) throw new AbortedError();
  // The token comes first, so a slow or failed login holds no timer or listener.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const authorization = await bearer(opts.auth, signal);
  if (authorization !== undefined) headers.Authorization = authorization;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await opts.fetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new AbortedError();
    if (timedOut) {
      throw new QuoterError({ status: 0, message: "The quote request timed out. Please retry.", retryable: true, cause });
    }
    // A browser reports CORS rejections and blocked origins as the same opaque network error as being
    // offline, so we can't tell them apart. Say so instead of blaming the user's connection only.
    throw new QuoterError({
      code: "QUOTER_UNREACHABLE",
      status: 0,
      message:
        "Couldn't reach the quote service. This is either a network problem or the service is blocking requests from this site's origin (CORS / allow-list).",
      retryable: true,
      cause,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const text = await res.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) throw toQuoterError(res.status, body, text);

  if (!isQuoterResponse(body)) {
    throw new QuoterError({
      status: res.status,
      apiError: "INVALID_RESPONSE",
      message: "The quote service returned an unexpected response.",
      retryable: false,
    });
  }
  return body;
}

/** The `Authorization` value from `auth`, which the caller's signal can stop waiting for. */
async function bearer(auth: QuoterClientOptions["auth"], signal: AbortSignal | undefined): Promise<string | undefined> {
  if (auth === undefined) return undefined;
  const token = typeof auth === "function" ? await abortable(Promise.resolve(auth(signal)), signal) : auth;
  if (typeof token !== "string" || token === "") throw new InvalidParamsError("`auth` gave an empty token.");
  return `Bearer ${token}`;
}

function toQuoterError(status: number, body: unknown, text: string): QuoterError {
  const b = (body && typeof body === "object" ? body : {}) as {
    error?: string;
    message?: string | string[];
    failures?: QuoterFailure[];
  };
  const apiError = typeof b.error === "string" ? b.error : undefined;
  const detail = Array.isArray(b.message) ? b.message.join(", ") : b.message;

  let message: string;
  if (apiError === "ALL_SOLVERS_FAILED") {
    message =
      status === 504
        ? "The quote request timed out. Please retry."
        : status === 422
          ? `The quote request was rejected${firstCode(b.failures)}.`
          : "No quote is available for this route and amount. Check the tokens, try a different amount, or retry later.";
  } else if (apiError && MESSAGES[apiError]) {
    message = MESSAGES[apiError]!;
  } else if (status === 403) {
    message =
      "The quote service refused this request (403 Forbidden). This site's origin or network is likely blocked.";
  } else if (status === 400) {
    message = `Invalid quote request${detail ? `: ${detail}` : "."}`;
  } else {
    message = detail ?? (text ? `Quote request failed (${status}).` : `Quote request failed with status ${status}.`);
  }

  const retryable =
    status === 429 ||
    status === 504 ||
    (status === 503 && apiError !== "SETTLER_PAUSED") ||
    (status === 502 && apiError === "SOLVER_FANOUT_FAILED");

  return new QuoterError({
    code: status === 403 ? "QUOTER_FORBIDDEN" : undefined,
    status,
    apiError,
    message,
    failures: b.failures,
    retryable,
  });
}

function firstCode(failures?: QuoterFailure[]): string {
  const code = failures?.find((f) => f.code)?.code;
  return code ? ` (${code})` : "";
}

function isQuoterResponse(body: unknown): body is QuoterResponse {
  const q = (body as QuoterResponse | undefined)?.quote;
  const out = q?.preview?.outputs?.[0];
  return (
    typeof q?.validUntil === "number" &&
    typeof out?.amount === "string" &&
    /^\d+$/.test(out.amount)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
