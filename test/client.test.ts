import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TaoIntents, type ProgressEvent } from "../src";
import { decodeAbiParameters } from "viem";
import { inputOrderDataParams } from "../src/abi";
import { ETH_INTENTS, jsonResponse, mockPublicClient, mockWalletClient, NOW, openLog, quoterBody, USER } from "./helpers";

const OUT_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function setup(opts: { origin?: Parameters<typeof mockPublicClient>[0]; fetchImpl?: unknown; now?: () => number } = {}) {
  const origin = mockPublicClient({
    logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 964 })],
    ...opts.origin,
  });
  const dest = mockPublicClient();
  const fetchMock = vi.fn((opts.fetchImpl as never) ?? (async () => jsonResponse(quoterBody())));
  const sdk = new TaoIntents({
    fetch: fetchMock as never,
    publicClients: { 1: origin.client as never, 964: dest.client as never },
    now: opts.now ?? (() => NOW),
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
    [{ originChainId: 1, destinationChainId: 964, inputToken: "ETH", outputToken: "TAO", amount: "1" }, "must be USDC"],
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
