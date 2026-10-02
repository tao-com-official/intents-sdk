import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TaoIntents, type ProgressEvent } from "../src";
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
function trackApprovals(wallet: ReturnType<typeof mockWalletClient>, origin: ReturnType<typeof mockPublicClient>) {
  const write = wallet.writeContract.getMockImplementation()!;
  wallet.writeContract.mockImplementation(async (args?: unknown) => {
    const a = args as { functionName: string; args: unknown[] };
    if (a.functionName === "approve") origin.state.allowance = a.args[1] as bigint;
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
      "switching-chain", "checking-balance", "approval-required", "approval-submitted", "approval-confirmed",
      "quoting", "quoted",
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
