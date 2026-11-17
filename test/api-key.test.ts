import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiKeyTokenSource } from "../src/api-key";
import { ApiKeyAuthError, InvalidParamsError } from "../src";
import { jsonResponse } from "./helpers";

const KEY = { apiKey: crypto.randomUUID(), apiSecret: "secret", authBaseUrl: "https://auth.test" };
const now = () => 0;
const ok = () => jsonResponse({ access_token: "t", token_type: "Bearer", refresh_token: "r", expires_in: 1800 });

describe("createApiKeyTokenSource", () => {
  afterEach(() => vi.useRealTimers());

  it("wraps a network failure in ApiKeyAuthError with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const source = createApiKeyTokenSource(KEY, (async () => Promise.reject(cause)) as never, now);
    const error = await source.getToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiKeyAuthError);
    expect((error as ApiKeyAuthError).cause).toBe(cause);
  });

  it.each([
    ["a 200 without access_token", () => jsonResponse({ expires_in: 1800 })],
    ["a 200 without expires_in", () => jsonResponse({ access_token: "t" })],
    ["a non-JSON body", () => new Response("<html>bad gateway</html>", { status: 200 })],
  ])("refuses %s", async (_case, reply) => {
    const source = createApiKeyTokenSource(KEY, (async () => reply()) as never, now);
    await expect(source.getToken()).rejects.toBeInstanceOf(ApiKeyAuthError);
  });

  it("doesn't cache a failed login: the next call logs in again", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(ok());
    const source = createApiKeyTokenSource(KEY, fetchFn as never, now);
    await expect(source.getToken()).rejects.toBeInstanceOf(ApiKeyAuthError);
    expect(await source.getToken()).toBe("t");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("logs in again after invalidate", async () => {
    const fetchFn = vi.fn(async () => ok());
    const source = createApiKeyTokenSource(KEY, fetchFn as never, now);
    await source.getToken();
    await source.getToken();
    source.invalidate();
    await source.getToken();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives the login its own timeout", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const source = createApiKeyTokenSource(KEY, fetchFn as never, now);
    const pending = source.getToken().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it("lets one caller abort without cancelling the login others share", async () => {
    let finish: (r: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    const source = createApiKeyTokenSource(KEY, fetchFn as never, now);
    const controller = new AbortController();
    const aborted = source.getToken(controller.signal);
    const other = source.getToken();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    finish(ok());
    expect(await other).toBe("t");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requires a key and a secret", () => {
    expect(() => createApiKeyTokenSource({ ...KEY, apiKey: "" }, fetch, now)).toThrow(InvalidParamsError);
    expect(() => createApiKeyTokenSource({ ...KEY, apiSecret: "" }, fetch, now)).toThrow(InvalidParamsError);
  });

  it("sends the secret only to an HTTPS origin, or plain HTTP on this machine", () => {
    for (const authBaseUrl of ["http://api.dev.tao.com", "https://api.tao.com/path", "https://u:p@api.tao.com", "not a url"]) {
      expect(() => createApiKeyTokenSource({ ...KEY, authBaseUrl }, fetch, now)).toThrow(InvalidParamsError);
    }
    expect(() => createApiKeyTokenSource({ ...KEY, authBaseUrl: "http://localhost:3001" }, fetch, now)).not.toThrow();
    expect(() => createApiKeyTokenSource({ ...KEY, authBaseUrl: "https://api.tao.com/" }, fetch, now)).not.toThrow();
  });

  it("refuses to run in a browser, where the secret would be visible", () => {
    const scope = globalThis as { window?: unknown; document?: unknown };
    scope.window = {};
    scope.document = {};
    try {
      expect(() => createApiKeyTokenSource(KEY, fetch, now)).toThrow("server only");
    } finally {
      delete scope.window;
      delete scope.document;
    }
  });

  it("refuses to run in a browser worker too", () => {
    const scope = globalThis as { importScripts?: unknown };
    scope.importScripts = () => {};
    try {
      expect(() => createApiKeyTokenSource(KEY, fetch, now)).toThrow("server only");
    } finally {
      delete scope.importScripts;
    }
  });

  it("refuses to run in React Native, whose bundle ships to users", () => {
    const scope = globalThis as { navigator?: unknown };
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true });
    try {
      expect(() => createApiKeyTokenSource(KEY, fetch, now)).toThrow("server only");
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete scope.navigator;
    }
  });
});
