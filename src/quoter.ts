import type { Address } from "viem";
import { AbortedError, QuoterError, type QuoterFailure } from "./errors";
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
}

export interface QuoterResponse {
  quote: {
    validUntil: number;
    preview: { inputs: Array<{ asset: string; amount: string }>; outputs: Array<{ asset: string; amount: string }> };
  };
  fees?: QuoterFees;
}

export interface QuoterClientOptions {
  url: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /** Extra attempts for transient failures (503/504, network errors, solver fan-out failures). */
  retries: number;
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
  for (;;) {
    try {
      return await attemptQuote(request, opts, signal);
    } catch (error) {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new AbortedError();
    throw new QuoterError({
      status: 0,
      message: timedOut
        ? "The quote request timed out. Please retry."
        : "Couldn't reach the quote service. Check your connection and retry.",
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

  return new QuoterError({ status, apiError, message, failures: b.failures, retryable });
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
