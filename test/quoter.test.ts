import { describe, expect, it, vi } from "vitest";
import { QuoterError } from "../src";
import { requestQuote, type QuoterRequest } from "../src/quoter";
import { jsonResponse, quoterBody, USER } from "./helpers";

const request: QuoterRequest = {
  originChainId: "1",
  destinationChainId: "964",
  inputTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  outputTokenAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  inputAmount: "100000000",
  userAddress: USER,
};
const opts = (fetchImpl: typeof fetch, retries = 0) => ({ url: "https://q.test", fetch: fetchImpl, timeoutMs: 1000, retries });

describe("requestQuote", () => {
  it("posts the request and returns the parsed quote", async () => {
    const f = vi.fn(async () => jsonResponse(quoterBody()));
    const res = await requestQuote(request, opts(f as never));
    expect(res.quote.preview.outputs[0]!.amount).toBe("320584403022379535");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://q.test");
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it("maps API errors to QuoterError with useful fields", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "SETTLER_PAUSED" }, 503));
    const err = await requestQuote(request, opts(f as never)).catch((e) => e);
    expect(err).toBeInstanceOf(QuoterError);
    expect(err).toMatchObject({ status: 503, apiError: "SETTLER_PAUSED", paused: true, retryable: false, code: "QUOTER_ERROR" });
  });

  it("treats 502 ALL_SOLVERS_FAILED as non-retryable and keeps failures", async () => {
    const failures = [{ solverId: 1, kind: "http_error", httpStatus: 500 }];
    const f = vi.fn(async () => jsonResponse({ error: "ALL_SOLVERS_FAILED", polled: 1, failures }, 502));
    const err = await requestQuote(request, opts(f as never, 3)).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.failures).toEqual(failures);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures, then succeeds", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "NO_SOLVERS_REGISTERED" }, 503))
      .mockResolvedValueOnce(jsonResponse(quoterBody()));
    const res = await requestQuote(request, opts(f as never, 1));
    expect(res.quote.validUntil).toBeGreaterThan(0);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not auto-retry rate limits", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "RATE_LIMITED", message: "retry after 3s" }, 429));
    const err = await requestQuote(request, opts(f as never, 3)).catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryable: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("reports network failures as retryable status 0", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const err = await requestQuote(request, opts(f as never)).catch((e) => e);
    expect(err).toMatchObject({ status: 0, retryable: true });
  });

  it("rejects malformed success bodies", async () => {
    const f = vi.fn(async () => jsonResponse({ quote: { validUntil: 1 } }));
    const err = await requestQuote(request, opts(f as never)).catch((e) => e);
    expect(err).toMatchObject({ apiError: "INVALID_RESPONSE" });
  });

  it("surfaces validation messages on 400", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "Bad Request", message: ["SAME_CHAIN_NOT_ALLOWED"] }, 400));
    const err = await requestQuote(request, opts(f as never)).catch((e) => e);
    expect(err.message).toContain("SAME_CHAIN_NOT_ALLOWED");
  });
});
