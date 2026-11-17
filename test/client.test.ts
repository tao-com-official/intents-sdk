import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { buildAttributionSuffix, TaoIntents, type ApiKeyOptions, type ProgressEvent } from "../src";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { inputOrderDataParams, subtensorDataParams } from "../src/abi";
import { encodeSs58, parseSubstrateAddress } from "../src/substrate";
import { ETH_INTENTS, jsonResponse, mockPublicClient, mockWalletClient, NOW, openLog, quoterBody, USER } from "./helpers";

const OUT_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function setup(opts: { origin?: Parameters<typeof mockPublicClient>[0]; fetchImpl?: unknown; now?: () => number; apiKey?: ApiKeyOptions; partnerId?: string; auth?: string } = {}) {
  const origin = mockPublicClient({
    logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 964 })],
    ...opts.origin,
  });
  const dest = mockPublicClient();
  const fetchMock = vi.fn((opts.fetchImpl as never) ?? (async () => jsonResponse(quoterBody())));
  const sdk = new TaoIntents({
    settlerLookup: false,
    fetch: fetchMock as never,
    publicClients: { 1: origin.client as never, 964: dest.client as never },
    now: opts.now ?? (() => NOW),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
    ...(opts.auth ? { auth: opts.auth } : {}),
  });
  return { sdk, origin, dest, fetchMock };
}

/** Make the mock chain honour approvals, like a real token would. */
function trackApprovals(wallet: ReturnType<typeof mockWalletClient>, origin: ReturnType<typeof mockPublicClient>, onApprove?: () => void) {
  const write = wallet.writeContract.getMockImplementation()!;
  wallet.writeContract.mockImplementation(async (args?: unknown) => {
    const a = args as { functionName: string; args: unknown[] };
    if (a.functionName === "approve") { origin.state.allowance = a.args[1] as bigint; onApprove?.(); }
    return write(args);
  });
}

describe("getQuote", () => {
  it("resolves symbols, parses amounts, and sends the right request", async () => {
    const { sdk, fetchMock } = setup();
    const quote = await sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100", user: USER });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({
      originChainId: "1",
      destinationChainId: "964",
      inputTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      outputTokenAddress: OUT_NATIVE,
      inputAmount: "100000000",
      userAddress: USER,
      recipient: USER,
      fillDeadline: NOW + 300,
    });
    expect(quote).toMatchObject({
      inputAmount: 100_000_000n,
      inputAmountFormatted: "100",
      outputAmount: 320584403022379535n,
      outputAmountFormatted: "0.320584403022379535",
      validUntil: NOW + 60,
      protocolFeeBps: 30,
      inputUsd: "99.99",
      outputUsd: "98.03",
      fees: { totalUsd: "1.96", effectiveRateBps: 196 },
    });
  });

  it.each([
    [{ originChainId: 1, destinationChainId: 1, outputToken: "USDC", amount: "1" }, "different"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "0" }, "greater than zero"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1.1234567" }, "decimal places"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO" }, "exactly one"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "DOGE", amount: "1" }, "Unknown token"],
    [{ originChainId: 1, destinationChainId: 964, inputToken: "DOGE", outputToken: "TAO", amount: "1" }, "Unknown token"],
    [{ originChainId: 1, destinationChainId: 10, outputToken: "TAO", amount: "1" }, "not supported"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", fillDeadline: NOW - 1 }, "future"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", fillDeadline: NOW + 100_000 }, "1 day"],
    [{ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", user: "0x123" as never }, "valid address"],
  ])("rejects bad input %#", async (params, fragment) => {
    const { sdk, fetchMock } = setup();
    await expect(sdk.getQuote(params as never)).rejects.toThrow(fragment);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates a failing protocol-fee read", async () => {
    const { sdk, origin } = setup();
    origin.client.readContract.mockRejectedValue(new Error("rpc"));
    const quote = await sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", user: USER });
    expect(quote.protocolFeeBps).toBeUndefined();
  });
});

describe("open / execute", () => {
  it("execute: approves, quotes, opens, and returns a tracked order", async () => {
    const { sdk, origin } = setup();
    const wallet = mockWalletClient({ chainId: 964 }); // wrong chain on purpose
    trackApprovals(wallet, origin);
    const steps: string[] = [];
    const result = await sdk.execute({
      wallet: wallet as never,
      originChainId: 1,
      destinationChainId: 964,
      outputToken: "TAO",
      amount: "100",
      onProgress: (e: ProgressEvent) => steps.push(e.step),
    });

    expect(wallet.switchChain).toHaveBeenCalledWith({ id: 1 });
    expect(steps).toEqual([
      "switching-chain", "checking-balance",
      "quoting", "quoted",                                   // feasibility first: no approval is paid for a doomed quote
      "approval-required", "approval-submitted", "approval-confirmed",
      // same quote reused: still valid after the approval
      "awaiting-signature", "submitted", "confirmed",
    ]);
    expect((wallet.writeContract.mock.calls as unknown as unknown[][])[0]![0]).toMatchObject({ functionName: "approve", args: [ETH_INTENTS, 100_000_000n] });
    const calls = wallet.writeContract.mock.calls as unknown as Array<[{ functionName: string; args: unknown[] }]>;
    expect(calls).toHaveLength(2);
    const openCall = calls[1]![0] as { functionName: string; args: [{ fillDeadline: number }] };
    expect(openCall.functionName).toBe("open");
    expect(openCall.args[0].fillDeadline).toBe(NOW + 300);
    expect(origin.client.simulateContract).toHaveBeenCalledOnce();

    expect(result.order.toJSON()).toMatchObject({ orderId: `0x${"ab".repeat(32)}`, originChainId: 1, destinationChainId: 964, fillDeadline: NOW + 300 });
    expect(result.quote.outputAmount).toBe(320584403022379535n);
  });

  it("execute skips the approval when the allowance is enough", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const result = await sdk.execute({ wallet: wallet as never, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100" });
    expect(wallet.writeContract).toHaveBeenCalledOnce();
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("stops early with InsufficientBalanceError, before quoting", async () => {
    const { sdk, fetchMock } = setup({ origin: { balance: 5n } });
    const wallet = mockWalletClient();
    await expect(
      sdk.execute({ wallet: wallet as never, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("execute re-quotes when the quote expires before sending", async () => {
    let t = NOW;
    let calls = 0;
    const { sdk, fetchMock } = setup({
      origin: { allowance: 10n ** 12n },
      now: () => t,
      fetchImpl: async () => {
        // first quote is already stale by the time open() runs
        calls++;
        const valid = calls === 1 ? t + 1 : t + 60;
        t += calls === 1 ? 5 : 0;
        return jsonResponse(quoterBody("100", valid));
      },
    });
    const wallet = mockWalletClient();
    const events: string[] = [];
    await sdk.execute({ wallet: wallet as never, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", onProgress: (e) => events.push(e.step) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContain("quote-refreshing");
  });

  it("gives up after maxQuoteRetries", async () => {
    let t = NOW;
    const { sdk, fetchMock } = setup({
      origin: { allowance: 10n ** 12n },
      now: () => t,
      fetchImpl: async () => { const v = t + 1; t += 5; return jsonResponse(quoterBody("100", v)); },
    });
    await expect(
      sdk.execute({ wallet: mockWalletClient() as never, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", maxQuoteRetries: 1 }),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("open refuses indicative quotes and mismatched wallets", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const indicative = await sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1" });
    await expect(sdk.open({ quote: indicative, wallet: mockWalletClient() as never })).rejects.toMatchObject({ code: "INDICATIVE_QUOTE" });

    const quote = await sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", user: USER });
    const other = mockWalletClient({ account: "0x2222222222222222222222222222222222222222" });
    await expect(sdk.open({ quote, wallet: other as never })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("decodes contract reverts into readable errors", async () => {
    const revert = new ContractFunctionRevertedError({
      abi: [],
      functionName: "open",
      data: "0x" as Hex,
    });
    Object.defineProperty(revert, "data", { value: { errorName: "FullSettler__ProtocolFeeExceedsMax", args: [] } });
    const { sdk } = setup({ origin: { allowance: 10n ** 12n, simulateError: new BaseError("sim failed", { cause: revert }) } });
    const quote = await sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1", user: USER });
    const wallet = mockWalletClient();
    const err = await sdk.open({ quote, wallet: wallet as never }).catch((e) => e);
    expect(err).toMatchObject({ code: "CONTRACT_REVERT", errorName: "FullSettler__ProtocolFeeExceedsMax" });
    expect(err.message).toContain("protocol fee changed");
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("maps wallet rejections to UserRejectedError", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    wallet.writeContract.mockRejectedValue(Object.assign(new Error("User rejected"), { code: 4001 }));
    await expect(
      sdk.execute({ wallet: wallet as never, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1" }),
    ).rejects.toMatchObject({ code: "USER_REJECTED" });
  });

  it("accepts a raw EIP-1193 provider", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const calls: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_requestAccounts") return [USER];
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_sendTransaction") return `0x${"ee".repeat(32)}`;
        throw new Error(`unexpected ${method}`);
      }),
    };
    const result = await sdk.execute({ wallet: provider, originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "1" });
    expect(calls).toContain("eth_sendTransaction");
    expect(result.txHash).toBe(`0x${"ee".repeat(32)}`);
  });
});

describe("order recovery", () => {
  it("rebuilds an order from a transaction hash", async () => {
    const { sdk } = setup();
    const order = await sdk.getOrderByTransaction(1, `0x${"11".repeat(32)}`);
    expect(order).toMatchObject({ originChainId: 1, destinationChainId: 964, fillDeadline: NOW + 300 });
    expect(order.explorerUrl).toBe(`https://etherscan.io/tx/0x${"11".repeat(32)}`);
  });

  it("errors when the receipt has no Open event", async () => {
    const { sdk } = setup({ origin: { logs: [] } });
    await expect(sdk.getOrderByTransaction(1, `0x${"11".repeat(32)}`)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});

const EXEC = { originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100" } as const;
const call = (w: ReturnType<typeof mockWalletClient>, i: number) =>
  (w.writeContract.mock.calls as unknown as Array<[{ functionName: string; args: any[] }]>)[i]![0];

describe("review: approval ordering", () => {
  it("does not spend an approval when the quote fails", async () => {
    const { sdk } = setup({ fetchImpl: async () => jsonResponse({ error: "ALL_SOLVERS_FAILED", polled: 1, failures: [] }, 502) });
    const wallet = mockWalletClient();
    await expect(sdk.execute({ wallet: wallet as never, ...EXEC })).rejects.toMatchObject({ code: "QUOTER_ERROR" });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("needs only one quote when the allowance already covers the order", async () => {
    const { sdk, fetchMock } = setup({ origin: { allowance: 10n ** 12n } });
    await sdk.execute({ wallet: mockWalletClient() as never, ...EXEC });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reuses the first quote after an approval when it is still valid", async () => {
    const { sdk, origin, fetchMock } = setup();
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin);
    await sdk.execute({ wallet: wallet as never, ...EXEC });
    expect(fetchMock).toHaveBeenCalledOnce(); // one quote, one approval, one open
  });

  it("re-quotes after an approval only when too little of the quote is left", async () => {
    let t = NOW;
    let n = 0;
    const { sdk, origin, fetchMock } = setup({
      now: () => t,
      fetchImpl: async () => jsonResponse(quoterBody(n++ === 0 ? "1000" : "1005", t + 60)),
    });
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin, () => { t += 50; }); // slow approval: 10s of validity left
    const r = await sdk.execute({ wallet: wallet as never, ...EXEC });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.quote.outputAmount).toBe(1005n);
    const [{ orderData }] = call(wallet, 1).args as [{ orderData: Hex }];
    expect(decodeAbiParameters(inputOrderDataParams, orderData)[0].outputAmount).toBe(1005n);
  });
});

describe("review: fillDeadline", () => {
  it("rejects deadlines under 60s and bad windows", async () => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...EXEC, fillDeadline: NOW + 59 })).rejects.toThrow("at least 60");
    expect(() => new TaoIntents({ fillWindowSeconds: 30 })).toThrow("between 60");
  });

  it("refreshes a default deadline right before signing", async () => {
    let t = NOW;
    const { sdk, origin } = setup({ origin: { allowance: 10n ** 12n }, now: () => t });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...EXEC, user: USER });
    expect(quote.fillDeadline).toBe(NOW + 300);
    t = NOW + 40; // user lingers on the review screen
    await sdk.open({ quote, wallet: wallet as never });
    const [{ fillDeadline }] = call(wallet, 0).args as [{ fillDeadline: number }];
    expect(fillDeadline).toBe(NOW + 40 + 300);
    expect(origin.client.simulateContract).toHaveBeenCalled();
  });

  it("appends the ERC-8021 suffix to simulate and open when `partnerId` is set", async () => {
    const { sdk, origin } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...EXEC, user: USER });
    await sdk.open({ quote, wallet: wallet as never, partnerId: "my-app" });
    const suffix = "6d792d617070" + "06" + "00" + "80218021802180218021802180218021";
    expect((call(wallet, 0) as unknown as { dataSuffix: string }).dataSuffix).toBe(`0x${suffix}`);
    const sim = (origin.client.simulateContract.mock.calls as unknown as Array<[{ dataSuffix: string }]>).at(-1)![0];
    expect(sim.dataSuffix).toBe(`0x${suffix}`);
  });

  it("rejects invalid partnerId values and omits the suffix by default", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...EXEC, user: USER });
    await expect(sdk.open({ quote, wallet: wallet as never, partnerId: "a,b" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(sdk.open({ quote, wallet: wallet as never, partnerId: "" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(sdk.open({ quote, wallet: wallet as never, partnerId: "a".repeat(101) })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await sdk.open({ quote, wallet: wallet as never });
    expect(call(wallet, 0)).not.toHaveProperty("dataSuffix");
  });

  it("keeps an explicit deadline, but refuses to send one with under 60s left", async () => {
    let t = NOW;
    const { sdk } = setup({ origin: { allowance: 10n ** 12n }, now: () => t });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...EXEC, user: USER, fillDeadline: NOW + 90 });
    expect(quote.fillDeadlineIsExplicit).toBe(true);
    await sdk.open({ quote, wallet: wallet as never });
    expect(call(wallet, 0).args[0].fillDeadline).toBe(NOW + 90);

    t = NOW + 45; // 45s left now
    const w2 = mockWalletClient();
    await expect(sdk.open({ quote, wallet: w2 as never })).rejects.toThrow("less than 60s");
    expect(w2.writeContract).not.toHaveBeenCalled();
  });
});

describe("review: output limits", () => {
  it("enforces minOutputAmount before anything is sent", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const err = await sdk.execute({ wallet: wallet as never, ...EXEC, minOutputAmount: 10n ** 18n }).catch((e) => e);
    expect(err).toMatchObject({ code: "OUTPUT_BELOW_MINIMUM", quoted: 320584403022379535n, minimum: 10n ** 18n });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("rejects a re-quote worse than slippageBps vs the first quote", async () => {
    let t = NOW;
    let n = 0;
    const { sdk, origin } = setup({ now: () => t, fetchImpl: async () => jsonResponse(quoterBody(n++ === 0 ? "10000" : "9800", t + 60)) }); // -2%
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin, () => { t += 50; });
    const err = await sdk.execute({ wallet: wallet as never, ...EXEC }).catch((e) => e);
    expect(err).toMatchObject({ code: "OUTPUT_BELOW_MINIMUM", minimum: 9900n });
    expect(err.approvalTxHash).toMatch(/^0x/); // approval was paid; retry won't repeat it
  });

  it("accepts it when within a looser slippageBps", async () => {
    let t = NOW;
    let n = 0;
    const { sdk, origin } = setup({ now: () => t, fetchImpl: async () => jsonResponse(quoterBody(n++ === 0 ? "10000" : "9800", t + 60)) });
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin, () => { t += 50; });
    const r = await sdk.execute({ wallet: wallet as never, ...EXEC, slippageBps: 300 });
    expect(r.quote.outputAmount).toBe(9800n);
  });

  it("open() honours minOutputAmount too", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const quote = await sdk.getQuote({ ...EXEC, user: USER });
    await expect(sdk.open({ quote, wallet: mockWalletClient() as never, minOutputAmount: quote.outputAmount + 1n })).rejects.toMatchObject({ code: "OUTPUT_BELOW_MINIMUM" });
  });
});

describe("review: abort signal", () => {
  it("aborts before doing any work", async () => {
    const { sdk, fetchMock } = setup();
    const ac = new AbortController();
    ac.abort();
    const wallet = mockWalletClient();
    await expect(sdk.execute({ wallet: wallet as never, ...EXEC, signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet.requestAddresses).not.toHaveBeenCalled();
  });

  it("aborts while waiting on the wallet", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    wallet.writeContract.mockImplementation(() => new Promise<never>(() => {})); // prompt left open
    const ac = new AbortController();
    const p = sdk.execute({ wallet: wallet as never, ...EXEC, signal: ac.signal, onProgress: (e) => e.step === "awaiting-signature" && ac.abort() });
    const err = await p.catch((e) => e);
    expect(err).toMatchObject({ code: "ABORTED", txHash: undefined });
  });

  it("aborts while waiting for the receipt and reports the in-flight tx hash", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n, hangReceipt: true } });
    const wallet = mockWalletClient();
    const ac = new AbortController();
    const err = await sdk
      .execute({ wallet: wallet as never, ...EXEC, signal: ac.signal, onProgress: (e) => e.step === "submitted" && ac.abort() })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ABORTED" });
    expect(err.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(err.message).toContain("already sent");
  });

  it("aborts a pending quote request", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n }, fetchImpl: (_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("x")))) });
    const ac = new AbortController();
    const p = sdk.execute({ wallet: mockWalletClient() as never, ...EXEC, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("review: replaced transactions", () => {
  const REPLACEMENT: Hex = `0x${"99".repeat(32)}`;

  it("returns the hash of the mined (sped-up) tx, not the first one sent", async () => {
    const logs = [openLog({ fillDeadline: NOW + 300, destinationChainId: 964 })];
    const { sdk } = setup({ origin: { allowance: 10n ** 12n, replacement: { reason: "repriced", hash: REPLACEMENT, logs } } });
    const wallet = mockWalletClient();
    const events: ProgressEvent[] = [];
    const r = await sdk.execute({ wallet: wallet as never, ...EXEC, onProgress: (e) => events.push(e) });
    expect(r.txHash).toBe(REPLACEMENT);
    expect(r.order.openTxHash).toBe(REPLACEMENT);
    expect(events.find((e) => e.step === "confirmed")).toMatchObject({ txHash: REPLACEMENT });
    expect(events.find((e) => e.step === "submitted")).not.toMatchObject({ txHash: REPLACEMENT });
  });

  it("reports a cancelled tx instead of a confusing 'no Open event'", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n, logs: [], replacement: { reason: "cancelled", hash: REPLACEMENT, logs: [] } } });
    const err = await sdk.execute({ wallet: mockWalletClient() as never, ...EXEC }).catch((e) => e);
    expect(err).toMatchObject({ code: "TRANSACTION_REPLACED", reason: "cancelled", replacementTxHash: REPLACEMENT });
  });

  it("uses the replacement's hash for a sped-up approval too", async () => {
    const { sdk, origin } = setup({ origin: { replacement: { reason: "repriced", hash: REPLACEMENT } } });
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin);
    const events: ProgressEvent[] = [];
    await sdk.execute({ wallet: wallet as never, ...EXEC, onProgress: (e) => events.push(e) });
    expect(events.find((e) => e.step === "approval-confirmed")).toMatchObject({ txHash: REPLACEMENT });
  });
});

describe("review: failure after the approval", () => {
  it("tells the caller the approval went through, and a retry skips it", async () => {
    let t = NOW;
    let n = 0;
    const { sdk, origin, fetchMock } = setup({
      now: () => t,
      fetchImpl: async () => (n++ === 1 ? jsonResponse({ error: "RATE_LIMITED" }, 429) : jsonResponse(quoterBody("1000", t + 60))),
    });
    const wallet = mockWalletClient();
    trackApprovals(wallet, origin, () => { t += 50; }); // forces the re-quote, which gets rate limited
    const err = await sdk.execute({ wallet: wallet as never, ...EXEC }).catch((e) => e);
    expect(err).toMatchObject({ code: "QUOTER_ERROR", status: 429 });
    expect(err.approvalTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Retry: allowance is in place, so no second approval.
    const before = wallet.writeContract.mock.calls.length;
    const r = await sdk.execute({ wallet: wallet as never, ...EXEC });
    expect(call(wallet, before).functionName).toBe("open");
    expect(r.approvalTxHash).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not attach an approval hash when none was sent", async () => {
    const { sdk } = setup({ origin: { allowance: 10n ** 12n }, fetchImpl: async () => jsonResponse({ error: "RATE_LIMITED" }, 429) });
    const err = await sdk.execute({ wallet: mockWalletClient() as never, ...EXEC }).catch((e) => e);
    expect(err.approvalTxHash).toBeUndefined();
  });
});

describe("Substrate recipient", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const COLDKEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
  const base = { originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100", recipient: SS58 };

  it("requests a transfer_tao leg instead of a recipient and opens with the TransferTao data", async () => {
    const { sdk, fetchMock } = setup({ origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const { quote } = await sdk.execute({ wallet: wallet as never, ...base });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.recipient).toBeUndefined();
    expect(body.subtensor).toEqual({ side: "destination", operation: "transfer_tao", recipientColdkey: SS58 });
    expect(quote.substrateRecipient).toBe(COLDKEY);
    expect(quote.recipient).toBe(USER);

    const [{ orderData }] = (wallet.writeContract.mock.calls as unknown as Array<[{ args: [{ orderData: Hex }] }]>)[0]![0].args;
    const d = decodeAbiParameters(inputOrderDataParams, orderData)[0];
    expect(d.outputToken).toBe(OUT_NATIVE);
    expect(d.recipient.toLowerCase()).toBe(`0x${"0".repeat(24)}${USER.slice(2).toLowerCase()}`);
    expect(d.subtensorData).toBe(quote.subtensorData);
    expect(d.subtensorData.length).toBe(2 + 5 * 64);
  });

  it("encodes a hex coldkey to SS58 for the request", async () => {
    const { sdk, fetchMock } = setup();
    await sdk.getQuote({ ...base, recipient: COLDKEY, user: USER });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.subtensor.recipientColdkey).toBe(SS58);
  });

  it("rejects Quoter data that pays someone else", async () => {
    const other = `0x${"2".repeat(2 * 32)}` as Hex;
    const { encodeTransferTao } = await import("../src/order-data");
    const bad = quoterBody();
    bad.quote.preview.outputs[0] = { ...bad.quote.preview.outputs[0]!, subtensorData: encodeTransferTao(other, 1n) } as never;
    const { sdk } = setup({ fetchImpl: async () => jsonResponse(bad) });
    await expect(sdk.getQuote({ ...base, user: USER })).rejects.toMatchObject({ code: "QUOTER_ERROR" });
  });

  it.each([
    [{ outputToken: "wTAO" }, "native TAO"],
    [{ originChainId: 964, destinationChainId: 1, outputToken: "ETH" }, "can't deliver"],
  ])("rejects unsupported route %#", async (override, fragment) => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...base, ...override, user: USER })).rejects.toThrow(fragment);
  });
});

describe("Subnet alpha output", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const COLDKEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
  const HOTKEY_SS58 = "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN";
  const base = { originChainId: 1, destinationChainId: 964, outputToken: "SN64", amount: "100", recipient: SS58, user: USER };
  const hotkey = () => parseSubstrateAddress(HOTKEY_SS58)!.accountId;

  function alphaData(over: Partial<{ operationType: number; netuid: number; delegatorHotkey: Hex; recipientColdkey: Hex; amount: bigint }> = {}) {
    return encodeAbiParameters(subtensorDataParams, [
      { operationType: 1, netuid: 64, delegatorHotkey: hotkey(), recipientColdkey: COLDKEY, amount: 5_000_000_000n, ...over },
    ]);
  }
  function quoterWith(data: Hex | undefined) {
    const body = quoterBody();
    body.quote.preview.outputs[0] = { ...body.quote.preview.outputs[0]!, ...(data && { subtensorData: data }) } as never;
    return async () => jsonResponse(body);
  }

  it("requests an alpha_stake leg and opens with the AlphaStake data", async () => {
    const { sdk, fetchMock } = setup({ origin: { allowance: 10n ** 12n }, fetchImpl: quoterWith(alphaData()) });
    const wallet = mockWalletClient();
    const { quote } = await sdk.execute({ wallet: wallet as never, ...(({ user: _u, ...rest }) => rest)(base) });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.recipient).toBeUndefined();
    expect(body.outputTokenAddress).toBe(OUT_NATIVE);
    expect(body.subtensor).toEqual({
      side: "destination", operation: "alpha_stake", netuid: 64, delegatorHotkey: HOTKEY_SS58, recipientColdkey: SS58,
    });
    expect(quote).toMatchObject({
      outputAmount: 5_000_000_000n,
      outputAmountFormatted: "5",
      orderOutputAmount: 320584403022379535n,
      alpha: { netuid: 64, hotkey: hotkey() },
      substrateRecipient: COLDKEY,
      recipient: USER,
    });
    expect(quote.outputToken).toMatchObject({ symbol: "SN64", decimals: 9, netuid: 64 });

    const [{ orderData }] = (wallet.writeContract.mock.calls as unknown as Array<[{ args: [{ orderData: Hex }] }]>)[0]![0].args;
    const d = decodeAbiParameters(inputOrderDataParams, orderData)[0];
    expect(d.outputToken).toBe(OUT_NATIVE);
    expect(d.outputAmount).toBe(320584403022379535n); // the TAO the solver stakes, not the alpha
    expect(d.destinationChainId).toBe(964n);
    expect(d.subtensorData).toBe(quote.subtensorData);
  });

  it("uses a custom hotkey", async () => {
    const other = encodeSs58(`0x${"07".repeat(32)}`);
    const { sdk, fetchMock } = setup({ fetchImpl: quoterWith(alphaData({ delegatorHotkey: `0x${"07".repeat(32)}` })) });
    await sdk.getQuote({ ...base, alphaHotkey: other });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.subtensor.delegatorHotkey).toBe(other);
  });

  it("applies minOutputAmount to the alpha amount", async () => {
    const { sdk } = setup({ fetchImpl: quoterWith(alphaData()) });
    const quote = await sdk.getQuote(base);
    await expect(sdk.open({ quote, wallet: mockWalletClient() as never, minOutputAmount: 6_000_000_000n })).rejects.toMatchObject({
      code: "OUTPUT_BELOW_MINIMUM",
    });
  });

  it.each([
    ["missing", undefined],
    ["another subnet", alphaData({ netuid: 1 })],
    ["another owner", alphaData({ recipientColdkey: `0x${"02".repeat(32)}` })],
    ["another validator", alphaData({ delegatorHotkey: `0x${"02".repeat(32)}` })],
    ["a TransferTao payload", alphaData({ operationType: 2 })],
    ["no alpha floor", alphaData({ amount: 0n })],
  ])("rejects Quoter data that is %s", async (_name, data) => {
    const { sdk } = setup({ fetchImpl: quoterWith(data) });
    await expect(sdk.getQuote(base)).rejects.toMatchObject({ code: "QUOTER_ERROR" });
  });

  it.each([
    [{ recipient: USER }, "Substrate coldkey"],
    [{ recipient: undefined }, "Substrate coldkey"],
    [{ destinationChainId: 1, originChainId: 964 }, "can't deliver"],
    [{ outputToken: "SN99999" }, "out of range"],
  ])("rejects invalid input %#", async (override, fragment) => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...base, ...override })).rejects.toThrow(fragment);
  });

  it("rejects alphaHotkey for other outputs", async () => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...base, outputToken: "TAO", alphaHotkey: HOTKEY_SS58 })).rejects.toThrow("alphaHotkey");
  });
});

describe("API key", () => {
  const PARTNER = "dcc91db5-f083-4672-b929-834695ceef92";
  const AUTH_ORIGIN = "https://auth.test";
  const KEY = { apiKey: crypto.randomUUID(), apiSecret: "secret", authBaseUrl: AUTH_ORIGIN };
  const isAuth = (url: string) => new URL(url).origin === AUTH_ORIGIN;

  /** Auth service and Quoter behind one fetch: records what each was sent. */
  function services(handlers: { login?: () => Response | Promise<Response>; quote?: (n: number) => Response } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let logins = 0;
    let quotes = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (isAuth(url)) {
        logins += 1;
        return (await handlers.login?.()) ?? jsonResponse({ access_token: `key-token-${logins}`, refresh_token: "r", token_type: "Bearer", expires_in: 1800 });
      }
      quotes += 1;
      return handlers.quote?.(quotes) ?? jsonResponse(quoterBody());
    };
    const authorizations = () =>
      calls.filter((c) => !isAuth(c.url)).map((c) => (c.init.headers as Record<string, string>).Authorization);
    return { fetchImpl, calls, authCalls: () => calls.filter((c) => isAuth(c.url)), authorizations };
  }

  it("logs in with the key once and sends its token with every quote", async () => {
    const { fetchImpl, authCalls, authorizations } = services();
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    await sdk.getQuote({ ...EXEC, user: USER });
    await sdk.getQuote({ ...EXEC, user: USER });

    expect(authCalls().map((c) => c.url)).toEqual([`${AUTH_ORIGIN}/auth`]);
    expect(JSON.parse(String(authCalls()[0]!.init.body))).toEqual({ type: "API_KEY", username: KEY.apiKey, password: "secret" });
    expect(authorizations()).toEqual(["Bearer key-token-1", "Bearer key-token-1"]);
  });

  it("keeps the token until 30 s before it expires, on the client's clock", async () => {
    let t = NOW;
    const { fetchImpl, authorizations } = services();
    const { sdk } = setup({ fetchImpl, apiKey: KEY, now: () => t });
    await sdk.getQuote({ ...EXEC, user: USER });
    t = NOW + 1800 - 31;
    await sdk.getQuote({ ...EXEC, user: USER });
    t = NOW + 1800 - 30;
    await sdk.getQuote({ ...EXEC, user: USER });

    expect(authorizations()).toEqual(["Bearer key-token-1", "Bearer key-token-1", "Bearer key-token-2"]);
  });

  it("shares one login between concurrent quotes", async () => {
    const { fetchImpl, authCalls } = services();
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    await Promise.all([sdk.getQuote({ ...EXEC, user: USER }), sdk.getQuote({ ...EXEC, user: USER })]);
    expect(authCalls()).toHaveLength(1);
  });

  it("drops a token the Quoter refuses and retries once with a fresh one", async () => {
    const { fetchImpl, authorizations } = services({ quote: (n) => (n === 1 ? jsonResponse({ error: "INVALID_API_KEY" }, 401) : jsonResponse(quoterBody())) });
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    await sdk.getQuote({ ...EXEC, user: USER });
    expect(authorizations()).toEqual(["Bearer key-token-1", "Bearer key-token-2"]);
  });

  it("gives up after the fresh token is refused too", async () => {
    const { fetchImpl, authorizations } = services({ quote: () => jsonResponse({ error: "INVALID_API_KEY" }, 401) });
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    await expect(sdk.getQuote({ ...EXEC, user: USER })).rejects.toMatchObject({ status: 401 });
    expect(authorizations()).toHaveLength(2);
  });

  it("stops waiting for a hung login when the caller aborts", async () => {
    const { fetchImpl } = services({ login: () => new Promise<Response>(() => {}) });
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    const controller = new AbortController();
    const pending = sdk.getQuote({ ...EXEC, user: USER }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("stops waiting for a hung auth function when the caller aborts", async () => {
    const { fetchImpl, calls } = services();
    const sdkWithAuth = new TaoIntents({ settlerLookup: false, fetch: fetchImpl as never, auth: () => new Promise<string>(() => {}) });
    const controller = new AbortController();
    const pending = sdkWithAuth.getQuote({ ...EXEC, user: USER }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls).toHaveLength(0);
  });

  it("sends a token passed as auth", async () => {
    const { fetchImpl, authorizations } = services();
    const { sdk } = setup({ fetchImpl, auth: "own-token" });
    await sdk.getQuote({ ...EXEC, user: USER });
    expect(authorizations()).toEqual(["Bearer own-token"]);
  });

  it("writes the client's partner ID as the ERC-8021 suffix, and a call's own overrides it", async () => {
    const { fetchImpl } = services();
    const { sdk } = setup({ fetchImpl, apiKey: KEY, partnerId: PARTNER, origin: { allowance: 10n ** 12n } });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...EXEC, user: USER });
    await sdk.open({ quote, wallet: wallet as never });
    await sdk.open({ quote: await sdk.getQuote({ ...EXEC, user: USER }), wallet: wallet as never, partnerId: "other-app" });
    const suffixes = [0, 1].map((i) => (call(wallet, i) as unknown as { dataSuffix: string }).dataSuffix);
    expect(suffixes[0]).toBe(buildAttributionSuffix(PARTNER));
    expect(suffixes[1]).toBe(buildAttributionSuffix("other-app"));
  });

  it("validates the client's partner ID up front", () => {
    expect(() => new TaoIntents({ partnerId: "a,b" })).toThrow("`partnerId`");
  });

  it("surfaces a refused key", async () => {
    const { fetchImpl } = services({ login: () => jsonResponse({ error: "invalid_client", error_description: "bad credentials" }, 401) });
    const { sdk } = setup({ fetchImpl, apiKey: KEY });
    await expect(sdk.getQuote({ ...EXEC, user: USER })).rejects.toMatchObject({
      code: "API_KEY_AUTH_FAILED",
      status: 401,
      message: expect.stringContaining("bad credentials"),
    });
  });

  it("refuses apiKey together with auth", () => {
    expect(() => new TaoIntents({ apiKey: KEY, auth: "token" })).toThrow("either `apiKey` or `auth`");
  });
});
