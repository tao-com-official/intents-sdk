import { decodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TaoIntents, type ProgressEvent } from "../src";
import { inputOrderDataParams, subtensorDataParams } from "../src/abi";
import { encodeAlphaStakeInput, STAKING_PRECOMPILE } from "../src/alpha";
import { buildOrder } from "../src/order-data";
import { applySlippage, quoteUsdcMinOut, resolveSwapEstimate, usableRoute, usdToUsdc } from "../src/swap";
import { encodeSs58 } from "../src/substrate";
import { DEFAULT_CHAINS } from "../src/config";
import { jsonResponse, MIRROR_COLDKEY, mockPublicClient, mockWalletClient, NOW, openLog, quoterBody, USER, type MockChainState } from "./helpers";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETH_INTENTS: Address = DEFAULT_CHAINS[1]!.intents;
const SUBTENSOR_INTENTS: Address = DEFAULT_CHAINS[964]!.intents;
const USDC_ETH: Address = DEFAULT_CHAINS[1]!.usdc;
const WETH: Address = DEFAULT_CHAINS[1]!.uniswap!.wrappedNative;
const LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const HOTKEY = "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN";
const HOTKEY_HEX: Hex = `0x${"ab".repeat(32)}`;

type Calls = Array<[{ functionName: string; address: Address; args: unknown[]; value?: bigint }]>;
const writes = (w: ReturnType<typeof mockWalletClient>) => w.writeContract.mock.calls as unknown as Calls;
const decodeOrder = (call: Calls[number][0]) => {
  const [order] = call.args as [{ fillDeadline: number; orderData: Hex }];
  return decodeAbiParameters(inputOrderDataParams, order.orderData)[0];
};

/** Quote body with a Uniswap hop, like the Quoter returns for a non-USDC input. */
function swapBody(opts: { route?: { poolFeeTier: number; amountOut: string } | null; outputAmount?: string; inputSubtensorData?: string } = {}) {
  const body = quoterBody(opts.outputAmount);
  if (opts.inputSubtensorData) (body.quote.preview.inputs[0] as { subtensorData?: string }).subtensorData = opts.inputSubtensorData;
  const route = opts.route === undefined ? { poolFeeTier: 500, amountOut: "100000000" } : opts.route;
  // the input is worth a little more than the pool pays for it
  if (route) (body.quote.preview.inputs[0] as { userPaysUsd?: string }).userPaysUsd = ((Number(route.amountOut) / 1e6) * 1.01).toFixed(2);
  return route ? { ...body, route: { tokenIn: WETH, tokenOut: USDC_ETH, ...route } } : body;
}

/** Ethereum -> Subtensor, paying with something other than USDC. */
function setupEth(opts: { origin?: MockChainState; body?: unknown } = {}) {
  const origin = mockPublicClient({ logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 964 })], ...opts.origin });
  const dest = mockPublicClient();
  const fetchMock = vi.fn(async () => jsonResponse(opts.body ?? swapBody()));
  const sdk = new TaoIntents({ fetch: fetchMock as never, publicClients: { 1: origin.client as never, 964: dest.client as never }, now: () => NOW });
  return { sdk, origin, dest, fetchMock };
}

/** Subtensor EVM -> Ethereum, paying with subnet alpha. */
function setupAlpha(opts: { origin?: MockChainState; body?: unknown } = {}) {
  const origin = mockPublicClient({
    logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 1, address: SUBTENSOR_INTENTS })],
    ...opts.origin,
  });
  const dest = mockPublicClient();
  const fetchMock = vi.fn(async () => jsonResponse(opts.body ?? swapBody({ route: { poolFeeTier: 3000, amountOut: "50000000" }, outputAmount: "45000000" })));
  const sdk = new TaoIntents({ fetch: fetchMock as never, publicClients: { 964: origin.client as never, 1: dest.client as never }, now: () => NOW });
  return { sdk, origin, dest, fetchMock };
}

const ethParams = { originChainId: 1, destinationChainId: 964, outputToken: "TAO", user: USER } as const;
const alphaParams = { originChainId: 964, destinationChainId: 1, inputToken: "SN64", outputToken: "USDC", alphaHotkey: HOTKEY, user: USER } as const;

describe("buildOrder with a swap", () => {
  const base = {
    user: USER,
    inputToken: USDC_ETH,
    inputAmount: 99n,
    outputToken: USDC_ETH,
    outputAmount: 90n,
    destinationChainId: 964,
    recipient: USER,
    maxProtocolFeeBps: 30,
    fillDeadline: NOW + 300,
    orderDataType: `0x${"cd".repeat(32)}` as Hex,
  };
  const decode = (o: ReturnType<typeof buildOrder>) => decodeAbiParameters(inputOrderDataParams, o.orderData)[0];

  it("leaves a USDC order with no swap fields", () => {
    expect(decode(buildOrder(base))).toMatchObject({ inputTokenToSwapFrom: zeroAddress, poolFee: 0, inputAmountToSwapFrom: 0n, swapDeadline: 0, inputAmount: 99n });
  });

  it("writes the swap fields and keeps USDC as the escrow token", () => {
    const swap = { inputTokenToSwapFrom: LINK, inputAmountToSwapFrom: 5n, poolFee: 3000, swapDeadline: NOW + 300 };
    expect(decode(buildOrder({ ...base, swap }))).toMatchObject({ ...swap, inputToken: USDC_ETH, inputAmount: 99n });
  });
});

describe("slippage and routes", () => {
  it("applies slippage, never to zero", () => {
    expect(applySlippage(10_000n, 100)).toBe(9_900n);
    expect(applySlippage(10_000n, 0)).toBe(10_000n);
    expect(applySlippage(1n, 5_000)).toBe(1n);
    expect(applySlippage(10_000n, 10_000)).toBe(1n);
  });

  it.each([
    [{ poolFeeTier: 500, amountOut: "100" }, true],
    [{ poolFeeTier: 777, amountOut: "100" }, false],
    [{ poolFeeTier: 500, amountOut: "0" }, false],
    [{ poolFeeTier: 500, amountOut: "" }, false],
    [{ poolFeeTier: 500, amountOut: "1.5" }, false],
    [undefined, false],
  ])("judges route %# usable=%s", (route, usable) => {
    expect(usableRoute(route as never) !== undefined).toBe(usable);
  });
});

describe("quoteUsdcMinOut", () => {
  const args = (origin: ReturnType<typeof mockPublicClient>) => ({
    client: origin.client as never,
    uniswap: DEFAULT_CHAINS[1]!.uniswap!,
    usdc: USDC_ETH,
    tokenIn: WETH,
    amountIn: 10n ** 18n,
    slippageBps: 100,
    chainName: "Ethereum",
  });

  it("keeps the best output across fee tiers, not the first that quotes", async () => {
    const origin = mockPublicClient({ quoterOut: { 500: 1_000n, 3000: 3_000_000_000n, 10000: 2_000_000_000n } });
    const estimate = await quoteUsdcMinOut(args(origin));
    expect(estimate).toEqual({ quotedUsdc: 3_000_000_000n, minUsdc: 2_970_000_000n, poolFee: 3000, source: "onchain" });
  });

  it("says there is no liquidity when every tier reverts", async () => {
    const origin = mockPublicClient({ quoterOut: {} });
    await expect(quoteUsdcMinOut(args(origin))).rejects.toMatchObject({ code: "SWAP_QUOTE_FAILED", message: expect.stringContaining("No Uniswap V3 liquidity") });
  });

  it("drops a tier that is too slow instead of waiting on it", async () => {
    const origin = mockPublicClient({ quoterOut: { 3000: 3_000_000_000n } });
    const fast = origin.client.simulateContract.getMockImplementation()!;
    // the 0.05% tier (a drained pool on Subtensor) never answers
    origin.client.simulateContract.mockImplementation(async (a?: { args?: unknown[] }) =>
      (a?.args?.[0] as { fee: number }).fee === 500 ? new Promise<never>(() => {}) : fast(a as never),
    );
    const estimate = await quoteUsdcMinOut({ ...args(origin), tierTimeoutMs: 30 });
    expect(estimate).toMatchObject({ poolFee: 3000, quotedUsdc: 3_000_000_000n });
  });

  it("reports a timeout as a pricing failure, not as missing liquidity", async () => {
    const origin = mockPublicClient();
    origin.client.simulateContract.mockImplementation(() => new Promise<never>(() => {}));
    const err = await quoteUsdcMinOut({ ...args(origin), tierTimeoutMs: 20 }).catch((e) => e);
    expect(err).toMatchObject({ code: "SWAP_QUOTE_FAILED" });
    expect(err.message).toContain("timed out");
    expect(err.message).not.toContain("liquidity");
  });

  it("surfaces a failing RPC as a swap-quote error that isn't 'no liquidity'", async () => {
    const origin = mockPublicClient();
    origin.client.simulateContract.mockRejectedValue(new Error("fetch failed"));
    const err = await quoteUsdcMinOut(args(origin)).catch((e) => e);
    expect(err).toMatchObject({ code: "SWAP_QUOTE_FAILED" });
    expect(err.message).toContain("fetch failed");
    expect(err.message).not.toContain("liquidity");
  });
});

describe("usdToUsdc", () => {
  it("reads the Quoter's USD values as USDC base units", () => {
    expect(usdToUsdc("51.506936")).toBe(51_506_936n);
    expect(usdToUsdc("2")).toBe(2_000_000n);
    expect(usdToUsdc("0.1234567")).toBe(123_456n);
    expect(usdToUsdc(undefined)).toBeUndefined();
    expect(usdToUsdc("abc")).toBeUndefined();
    expect(usdToUsdc("-1")).toBeUndefined();
  });
});

describe("resolveSwapEstimate", () => {
  const base = (origin: ReturnType<typeof mockPublicClient>) => ({
    client: origin.client as never,
    uniswap: DEFAULT_CHAINS[1]!.uniswap!,
    usdc: USDC_ETH,
    tokenIn: WETH,
    amountIn: 10n ** 18n,
    slippageBps: 100,
    chainName: "Ethereum",
  });

  it("keeps the Quoter's route when the pool agrees with it", async () => {
    const origin = mockPublicClient({ quoterOut: { 500: 1_020_000n } }); // 2% apart
    const estimate = await resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "1000000" } });
    expect(estimate).toEqual({ quotedUsdc: 1_000_000n, minUsdc: 990_000n, poolFee: 500, source: "quoter" });
    expect(origin.client.simulateContract).toHaveBeenCalledTimes(1); // only the tier the Quoter chose
  });

  it("keeps the Quoter's route when the pool can't be asked", async () => {
    const origin = mockPublicClient(); // no pool quotes: every tier reverts
    const estimate = await resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "1000000" } });
    expect(estimate).toMatchObject({ source: "quoter", minUsdc: 990_000n });
  });

  it("prices from the pool when the route is far below it (a floor that protects nothing)", async () => {
    const origin = mockPublicClient({ quoterOut: { 500: 5_000_000n } });
    const estimate = await resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "10" } });
    expect(estimate).toEqual({ quotedUsdc: 5_000_000n, minUsdc: 4_950_000n, poolFee: 500, source: "onchain" });
  });

  it("prices from the pool when the route is far above it (a floor the swap can't meet)", async () => {
    const origin = mockPublicClient({ quoterOut: { 500: 1_000_000n } });
    const estimate = await resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "2000000" } });
    expect(estimate).toMatchObject({ source: "onchain", quotedUsdc: 1_000_000n });
  });

  it("refuses a floor far under what the input is worth, whatever the output token", async () => {
    const origin = mockPublicClient();
    const route = { poolFeeTier: 500, amountOut: "1000" };
    await expect(resolveSwapEstimate({ ...base(origin), route, referenceUsdc: 100_000_000n })).rejects.toMatchObject({ code: "SWAP_QUOTE_FAILED", message: expect.stringContaining("the input is worth") });
    await expect(resolveSwapEstimate({ ...base(origin), route, referenceUsdc: 1_500n })).resolves.toMatchObject({ source: "quoter" });
  });

  it("falls back to the pool when the route is unusable", async () => {
    const origin = mockPublicClient({ quoterOut: { 500: 5_000_000n } });
    const estimate = await resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 42, amountOut: "1" } });
    expect(estimate).toMatchObject({ source: "onchain", poolFee: 500 });
  });

  it("refuses a floor far under the promised output", async () => {
    const origin = mockPublicClient();
    await expect(
      resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "693" }, promisedUsdc: 12_540_000n }),
    ).rejects.toMatchObject({ code: "SWAP_QUOTE_FAILED" });
  });

  it("doesn't compare against a promise when the output isn't USDC", async () => {
    const origin = mockPublicClient();
    await expect(resolveSwapEstimate({ ...base(origin), route: { poolFeeTier: 500, amountOut: "693" } })).resolves.toMatchObject({ poolFee: 500 });
  });
});

describe("getQuote with a non-USDC input", () => {
  it("quotes native ETH with 18 decimals and the native sentinel", async () => {
    const { sdk, fetchMock } = setupEth();
    const quote = await sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "0.5" });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ originChainId: "1", inputTokenAddress: NATIVE, inputAmount: (5n * 10n ** 17n).toString() });
    expect(quote).toMatchObject({ inputKind: "native", inputAmount: 5n * 10n ** 17n, inputAmountFormatted: "0.5", swapRoute: { poolFeeTier: 500 } });
  });

  it("classifies USDC and a known ERC-20", async () => {
    expect((await setupEth().sdk.getQuote({ ...ethParams, amount: "1" })).inputKind).toBe("usdc");
    const sub = new TaoIntents({
      fetch: (async () => jsonResponse(swapBody())) as never,
      publicClients: { 1: mockPublicClient().client as never, 964: mockPublicClient().client as never },
      now: () => NOW,
    });
    const quote = await sub.getQuote({ originChainId: 964, destinationChainId: 1, inputToken: "wTAO", outputToken: "USDC", amount: "2" });
    expect(quote).toMatchObject({ inputKind: "erc20", inputAmount: 2n * 10n ** 18n });
  });

  it("reads the decimals of an unknown token address, once", async () => {
    const { sdk, origin } = setupEth({ origin: { decimals: 8 } });
    const quote = await sdk.getQuote({ ...ethParams, inputToken: LINK, amount: "1.5" });
    await sdk.getQuote({ ...ethParams, inputToken: LINK, amount: "1" });
    expect(quote).toMatchObject({ inputKind: "erc20", inputAmount: 150_000_000n });
    const reads = (origin.client.readContract.mock.calls as unknown as Array<[{ functionName: string }]>).filter(([a]) => a.functionName === "decimals");
    expect(reads).toHaveLength(1);
  });

  it("rejects an address that isn't a token", async () => {
    const { sdk, fetchMock } = setupEth({ origin: { decimals: null } });
    await expect(sdk.getQuote({ ...ethParams, inputToken: LINK, amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a swap input on a chain with no Uniswap deployment", async () => {
    const origin = mockPublicClient();
    const sdk = new TaoIntents({
      fetch: (async () => jsonResponse(swapBody())) as never,
      publicClients: { 1: origin.client as never, 964: mockPublicClient().client as never },
      chains: { 1: { uniswap: undefined } },
    });
    await expect(sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
  });
});

describe("open with a native input", () => {
  it("sends the amount as value, needs no approval and escrows the floor", async () => {
    const { sdk, origin } = setupEth();
    const wallet = mockWalletClient();
    const steps: ProgressEvent[] = [];
    const quote = await sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "0.5" });
    const result = await sdk.open({ quote, wallet: wallet as never, onProgress: (e) => steps.push(e) });

    const calls = writes(wallet);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ functionName: "open", value: 5n * 10n ** 17n });
    expect(decodeOrder(calls[0]![0])).toMatchObject({
      inputTokenToSwapFrom: NATIVE,
      inputAmountToSwapFrom: 5n * 10n ** 17n,
      poolFee: 500,
      swapDeadline: NOW + 300,
      inputToken: USDC_ETH,
      inputAmount: 99_000_000n, // route.amountOut 100 USDC less 1%
    });
    const sim = (origin.client.simulateContract.mock.calls as unknown as Calls).at(-1)![0];
    expect(sim.value).toBe(5n * 10n ** 17n);
    expect(steps.map((e) => e.step)).toContain("swap-quoted");
    expect(steps.find((e) => e.step === "swap-quoted")).toMatchObject({ minUsdc: 99_000_000n, poolFee: 500, source: "quoter" });
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("checks the native balance", async () => {
    const { sdk } = setupEth({ origin: { nativeBalance: 1n } });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "0.5" });
    await expect(sdk.open({ quote, wallet: wallet as never })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", message: expect.stringContaining("ETH") });
    expect(writes(wallet)).toHaveLength(0);
  });

  it("prices through the pool when the Quoter sent no route, and swaps as the wrapped native token", async () => {
    const { sdk, origin } = setupEth({ body: swapBody({ route: null }), origin: { quoterOut: { 500: 80_000_000n, 3000: 100_000_000n } } });
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "0.5" });
    await sdk.open({ quote, wallet: wallet as never, swapSlippageBps: 50 });
    expect(decodeOrder(writes(wallet)[0]![0])).toMatchObject({ poolFee: 3000, inputAmount: 99_500_000n });
    const quoterCall = (origin.client.simulateContract.mock.calls as unknown as Calls).find(([a]) => a.functionName === "quoteExactInputSingle")![0];
    expect(quoterCall.args[0]).toMatchObject({ tokenIn: WETH, tokenOut: USDC_ETH, amountIn: 5n * 10n ** 17n });
  });

  it("rejects a bad swapSlippageBps before touching the wallet", async () => {
    const { sdk } = setupEth();
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...ethParams, inputToken: "ETH", amount: "0.5" });
    await expect(sdk.open({ quote, wallet: wallet as never, swapSlippageBps: -1 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(sdk.execute({ ...ethParams, user: undefined, inputToken: "ETH", amount: "1", wallet: wallet as never, swapSlippageBps: 10_001 } as never)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("open with an ERC-20 input", () => {
  const params = { ...ethParams, inputToken: LINK, amount: "10" } as const;

  it("approves the token itself, not USDC, for exactly the amount", async () => {
    const { sdk, origin } = setupEth({ origin: { decimals: 18, allowance: 0n, balance: 10n ** 24n } });
    const wallet = mockWalletClient();
    const write = wallet.writeContract.getMockImplementation()!;
    wallet.writeContract.mockImplementation(async (args?: unknown) => {
      const a = args as { functionName: string; args: unknown[] };
      if (a.functionName === "approve") origin.state.allowance = a.args[1] as bigint;
      return write(args);
    });
    const quote = await sdk.getQuote(params);
    const result = await sdk.open({ quote, wallet: wallet as never });

    const calls = writes(wallet);
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ functionName: "approve", address: LINK, args: [ETH_INTENTS, 10n * 10n ** 18n] });
    expect(calls[1]![0].value).toBeUndefined();
    expect(decodeOrder(calls[1]![0])).toMatchObject({ inputTokenToSwapFrom: LINK, inputAmountToSwapFrom: 10n * 10n ** 18n, inputToken: USDC_ETH });
    expect(result.approvalTxHash).toBeDefined();
  });

  it("checks the token's balance and reports its symbol", async () => {
    const { sdk } = setupEth({ origin: { decimals: 18, balance: 1n } });
    const quote = await sdk.getQuote(params);
    await expect(sdk.open({ quote, wallet: mockWalletClient() as never })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });

  it("resets the allowance first for a token that refuses non-zero to non-zero approvals", async () => {
    const { sdk, origin } = setupEth({ origin: { decimals: 18, allowance: 5n, balance: 10n ** 24n, approveSimulateFails: true } });
    const wallet = mockWalletClient();
    const write = wallet.writeContract.getMockImplementation()!;
    wallet.writeContract.mockImplementation(async (args?: unknown) => {
      const a = args as { functionName: string; args: unknown[] };
      if (a.functionName === "approve") origin.state.allowance = a.args[1] as bigint;
      return write(args);
    });
    const quote = await sdk.getQuote(params);
    await sdk.open({ quote, wallet: wallet as never });
    const approvals = writes(wallet).filter(([a]) => a.functionName === "approve").map(([a]) => a.args[1]);
    expect(approvals).toEqual([0n, 10n * 10n ** 18n]);
  });

  it("doesn't pay for an approval when the swap can't be priced", async () => {
    const { sdk } = setupEth({ origin: { decimals: 18, allowance: 0n, balance: 10n ** 24n, quoterOut: {} }, body: swapBody({ route: null }) });
    const wallet = mockWalletClient();
    const err = await sdk.execute({ ...params, user: undefined, wallet: wallet as never } as never).catch((e) => e);
    expect(err).toMatchObject({ code: "SWAP_QUOTE_FAILED" });
    expect(writes(wallet)).toHaveLength(0);
  });

  it("execute approves the token, then opens with the same quote", async () => {
    const { sdk, origin, fetchMock } = setupEth({ origin: { decimals: 18, allowance: 0n, balance: 10n ** 24n } });
    const wallet = mockWalletClient();
    const write = wallet.writeContract.getMockImplementation()!;
    wallet.writeContract.mockImplementation(async (args?: unknown) => {
      const a = args as { functionName: string; args: unknown[] };
      if (a.functionName === "approve") origin.state.allowance = a.args[1] as bigint;
      return write(args);
    });
    const { user: _user, ...executeParams } = params;
    const result = await sdk.execute({ ...executeParams, wallet: wallet as never });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writes(wallet).map(([a]) => a.functionName)).toEqual(["approve", "open"]);
    expect(result.quote.inputKind).toBe("erc20");
  });
});

describe("ensureApproval", () => {
  it("does nothing for a native token", async () => {
    const { sdk } = setupEth();
    const wallet = mockWalletClient();
    await expect(sdk.ensureApproval({ wallet: wallet as never, originChainId: 1, inputToken: "ETH", amount: "1" })).resolves.toEqual({});
    expect(writes(wallet)).toHaveLength(0);
  });

  it("approves a chosen ERC-20", async () => {
    const { sdk } = setupEth({ origin: { decimals: 6 } });
    const wallet = mockWalletClient();
    const out = await sdk.ensureApproval({ wallet: wallet as never, originChainId: 1, inputToken: LINK, amount: "3" });
    expect(out.approvalTxHash).toBeDefined();
    expect(writes(wallet)[0]![0]).toMatchObject({ address: LINK, functionName: "approve", args: [ETH_INTENTS, 3_000_000n] });
  });

  it("approves alpha through the staking precompile", async () => {
    const { sdk } = setupAlpha();
    const wallet = mockWalletClient({ chainId: 964 });
    await sdk.ensureApproval({ wallet: wallet as never, originChainId: 964, inputToken: "SN64", amount: "2" });
    expect(writes(wallet)[0]![0]).toMatchObject({ address: STAKING_PRECOMPILE, functionName: "approve", args: [SUBTENSOR_INTENTS, 64n, 2_000_000_000n] });
  });
});

describe("subnet alpha input", () => {
  it("needs the user and the hotkey the stake sits on", async () => {
    const { sdk, fetchMock } = setupAlpha();
    await expect(sdk.getQuote({ ...alphaParams, user: undefined, amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("`user`") });
    await expect(sdk.getQuote({ ...alphaParams, alphaHotkey: undefined, amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("`alphaHotkey`") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can't be input and output together", async () => {
    const { sdk } = setupAlpha();
    await expect(sdk.getQuote({ ...alphaParams, outputToken: "SN1", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
  });

  it("asks for a source stake leg on the user's mirror coldkey, in rao", async () => {
    const { sdk, fetchMock } = setupAlpha();
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1.5" });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({
      originChainId: "964",
      destinationChainId: "1",
      inputTokenAddress: NATIVE,
      inputAmount: "1500000000",
      subtensor: {
        side: "source",
        operation: "alpha_stake",
        netuid: 64,
        delegatorHotkey: HOTKEY,
        recipientColdkey: encodeSs58(MIRROR_COLDKEY),
        amount: "1500000000",
      },
    });
    expect(body.recipient).toBeUndefined();
    expect(quote).toMatchObject({ inputKind: "alpha", inputAmount: 1_500_000_000n, inputAmountFormatted: "1.5" });
    expect(quote.alphaInput).toMatchObject({ netuid: 64, coldkey: MIRROR_COLDKEY, amount: 1_500_000_000n });
    // the Quoter sent no stake data, so it is built locally
    const [data] = decodeAbiParameters(subtensorDataParams, quote.alphaInput!.subtensorData);
    expect(data).toMatchObject({ operationType: 1, netuid: 64, amount: 1_500_000_000n });
  });

  it("accepts the Quoter's stake data when it matches, rejects it when it doesn't", async () => {
    const hotkey = (await import("../src/substrate")).parseSubstrateAddress(HOTKEY)!.accountId;
    const good = encodeAlphaStakeInput({ netuid: 64, hotkey, coldkey: MIRROR_COLDKEY, alphaRao: 1_000_000_000n });
    const ok = await setupAlpha({ body: swapBody({ inputSubtensorData: good }) }).sdk.getQuote({ ...alphaParams, amount: "1" });
    expect(ok.alphaInput!.subtensorData).toBe(good);

    for (const bad of [
      encodeAlphaStakeInput({ netuid: 65, hotkey, coldkey: MIRROR_COLDKEY, alphaRao: 1_000_000_000n }),
      encodeAlphaStakeInput({ netuid: 64, hotkey: HOTKEY_HEX, coldkey: MIRROR_COLDKEY, alphaRao: 1_000_000_000n }),
      encodeAlphaStakeInput({ netuid: 64, hotkey, coldkey: MIRROR_COLDKEY, alphaRao: 2_000_000_000n }),
      "0xdeadbeef",
    ]) {
      await expect(setupAlpha({ body: swapBody({ inputSubtensorData: bad }) }).sdk.getQuote({ ...alphaParams, amount: "1" })).rejects.toMatchObject({ apiError: "INVALID_RESPONSE" });
    }
  });

  it("approves the settler on the subnet, unstakes through the order and sends no value", async () => {
    const { sdk, origin } = setupAlpha({ origin: { simProceedsRao: 2_000_000_000n } });
    const wallet = mockWalletClient({ chainId: 964 });
    const write = wallet.writeContract.getMockImplementation()!;
    wallet.writeContract.mockImplementation(async (args?: unknown) => {
      const a = args as { functionName: string; args: unknown[]; address: string };
      if (a.functionName === "approve") origin.state.stakeAllowance = a.args[2] as bigint;
      return write(args);
    });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    const steps: ProgressEvent[] = [];
    const result = await sdk.open({ quote, wallet: wallet as never, onProgress: (e) => steps.push(e) });

    const calls = writes(wallet);
    expect(calls.map(([a]) => a.functionName)).toEqual(["approve", "open"]);
    expect(calls[0]![0]).toMatchObject({ address: STAKING_PRECOMPILE, args: [SUBTENSOR_INTENTS, 64n, 1_000_000_000n] });
    expect(steps.find((e) => e.step === "approval-required")).toMatchObject({ kind: "alpha-stake", amount: 1_000_000_000n });
    expect(calls[1]![0].value).toBeUndefined();

    const order = decodeOrder(calls[1]![0]);
    expect(order).toMatchObject({
      inputTokenToSwapFrom: zeroAddress,
      // 1 alpha unstakes to 2 TAO (2e9 rao -> 2e18 wei); the floor is that less 1%
      inputAmountToSwapFrom: 1_980_000_000_000_000_000n,
      poolFee: 3000,
      inputToken: DEFAULT_CHAINS[964]!.usdc,
      inputAmount: 49_500_000n, // route.amountOut 50 USDC less 1%
    });
    const [data] = decodeAbiParameters(subtensorDataParams, order.subtensorData);
    expect(data).toMatchObject({ operationType: 1, netuid: 64, amount: 1_000_000_000n });
    expect(result.approvalTxHash).toBeDefined();
  });

  it("skips the approval when the settler is already allowed", async () => {
    const { sdk } = setupAlpha({ origin: { stakeAllowance: 10n ** 12n } });
    const wallet = mockWalletClient({ chainId: 964 });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    const result = await sdk.open({ quote, wallet: wallet as never });
    expect(writes(wallet).map(([a]) => a.functionName)).toEqual(["open"]);
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("stops before any approval when there isn't enough alpha staked", async () => {
    const { sdk } = setupAlpha({ origin: { stake: 1n } });
    const wallet = mockWalletClient({ chainId: 964 });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    await expect(sdk.open({ quote, wallet: wallet as never })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", message: expect.stringContaining("SN64 alpha") });
    expect(writes(wallet)).toHaveLength(0);
  });

  it("execute checks the stake and prices the unstake before paying for the approval", async () => {
    const { sdk } = setupAlpha({ origin: { stake: 1n } });
    const wallet = mockWalletClient({ chainId: 964 });
    const { user: _user, ...params } = alphaParams;
    const err = await sdk.execute({ ...params, amount: "1", wallet: wallet as never }).catch((e) => e);
    expect(err).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(writes(wallet)).toHaveLength(0);
  });

  it("fails clearly when the unstake can't be priced", async () => {
    const { sdk, origin } = setupAlpha();
    origin.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "addressMapping") return MIRROR_COLDKEY;
      if (functionName === "getStake") return 10n ** 12n;
      if (functionName === "allowance") return 0n;
      throw new Error("precompile failed");
    });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    await expect(sdk.open({ quote, wallet: mockWalletClient({ chainId: 964 }) as never })).rejects.toMatchObject({
      code: "SWAP_QUOTE_FAILED",
      message: expect.stringContaining("SN64"),
    });
  });

  it("unstakes root stake 1:1 without asking the pool simulation", async () => {
    const { sdk, origin } = setupAlpha({ origin: { stakeAllowance: 10n ** 12n } });
    const quote = await sdk.getQuote({ ...alphaParams, inputToken: "SN0", amount: "1" });
    const wallet = mockWalletClient({ chainId: 964 });
    await sdk.open({ quote, wallet: wallet as never });
    expect(decodeOrder(writes(wallet)[0]![0]).inputAmountToSwapFrom).toBe(990_000_000_000_000_000n); // 1 alpha = 1 TAO, less 1%
    expect((origin.client.readContract.mock.calls as unknown as Array<[{ functionName: string }]>).some(([a]) => a.functionName === "simSwapAlphaForTao")).toBe(false);
  });
});

describe("swap errors are readable", () => {
  it("explains a swap that returned less than the floor", async () => {
    const { normalizeError } = await import("../src/normalize");
    const { REVERT_MESSAGES } = await import("../src/errors");
    expect(REVERT_MESSAGES.FullSettler__SwapAmountTooLow).toContain("price moved");
    expect(REVERT_MESSAGES.SubtensorStakingLib__LowerThanExpectedTaoAfterUnstake).toContain("price moved");
    expect(normalizeError(new Error("x"), "open").code).toBe("WALLET_ERROR");
  });
});

describe("plain Error(string) reverts", () => {
  it("explains the router's 'Too little received' instead of printing 'Error'", async () => {
    const { BaseError, ContractFunctionRevertedError } = await import("viem");
    const { normalizeError } = await import("../src/normalize");
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: "open", data: "0x" as Hex });
    Object.defineProperty(revert, "data", { value: { errorName: "Error", args: ["Too little received"] } });
    Object.defineProperty(revert, "reason", { value: "Too little received" });
    const err = normalizeError(new BaseError("sim failed", { cause: revert }), "open the intent");
    expect(err).toMatchObject({ code: "CONTRACT_REVERT" });
    expect(err.message).toContain("swapSlippageBps");
    expect(err.message).not.toContain(": Error");
  });

  it("shows an unknown reason verbatim", async () => {
    const { BaseError, ContractFunctionRevertedError } = await import("viem");
    const { normalizeError } = await import("../src/normalize");
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: "open", data: "0x" as Hex });
    Object.defineProperty(revert, "data", { value: { errorName: "Error", args: ["Something odd"] } });
    Object.defineProperty(revert, "reason", { value: "Something odd" });
    expect(normalizeError(new BaseError("x", { cause: revert }), "open the intent").message).toContain("Something odd");
  });
});
