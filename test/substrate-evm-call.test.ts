import { decodeAbiParameters, decodeFunctionData, encodeEventTopics, erc20Abi, getAbiItem, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { polkadotSigner, substrateEvmAddress, TaoIntents, type ProgressEvent, type SubstrateCall, type SubstrateSigner } from "../src";
import { inputOrderDataParams, intentsAbi } from "../src/abi";
import { STAKING_PRECOMPILE, stakingAbi } from "../src/alpha";
import { DEFAULT_CHAINS } from "../src/config";
import { alphaSellLeavingSlack, buildEvmCallBatch, buildEvmCallTransferBatch, evmAddressOfAccountId } from "../src/evm-call";
import { encodeSs58 } from "../src/substrate";
import { jsonResponse, MIRROR_COLDKEY, mockPublicClient, mockWalletClient, NOW, ORDER_ID, quoterBody, USER, type MockChainState } from "./helpers";

const INTENTS: Address = DEFAULT_CHAINS[964]!.intents;
const USDC_964: Address = DEFAULT_CHAINS[964]!.usdc;
const WTAO: Address = DEFAULT_CHAINS[964]!.uniswap!.wrappedNative;
const COLDKEY: Hex = `0x${Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, "0")).join("")}`;
const SOURCE = evmAddressOfAccountId(COLDKEY);
const COLDKEY_SS58 = encodeSs58(COLDKEY);
const HOTKEY = "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN";
const RECIPIENT: Address = "0x2222222222222222222222222222222222222222";
const OPEN_TOPIC = encodeEventTopics({ abi: intentsAbi, eventName: "Open", args: { orderId: ORDER_ID } })[0]!;
const GAS_PRICE = 10_000_000_000n; // 10 gwei, the mock's

const openedEvents = (extra: Array<{ section: string; method: string; data: unknown[] }> = []) => [
  { section: "evm", method: "Log", data: [{ address: INTENTS, topics: [OPEN_TOPIC, ORDER_ID], data: "0x" }] },
  { section: "evm", method: "Executed", data: [INTENTS] },
  ...extra,
];

/** A signer that records the batch and answers like a chain that included it. */
function fakeSigner(opts: { events?: ReturnType<typeof openedEvents>; spendable?: bigint; fail?: unknown; address?: string } = {}) {
  const signAndSendBatch = vi.fn(async (_calls: SubstrateCall[], options?: { onSigned?: (h: Hex) => void; beforeSubmit?: () => void }) => {
    if (opts.fail) throw opts.fail;
    options?.beforeSubmit?.();
    options?.onSigned?.(`0x${"11".repeat(32)}`);
    return { extrinsicHash: `0x${"11".repeat(32)}` as Hex, blockHash: `0x${"22".repeat(32)}` as Hex, events: opts.events ?? openedEvents() };
  });
  const spendableAfterFee = vi.fn(async () => opts.spendable ?? 10n ** 15n);
  const signer: SubstrateSigner = { address: opts.address ?? COLDKEY_SS58, signAndSendBatch, spendableAfterFee };
  return { signer, signAndSendBatch, spendableAfterFee };
}

function swapBody() {
  const body = quoterBody("45000000");
  body.quote.preview.inputs[0]!.userPaysUsd = "50.5";
  return { ...body, route: { tokenIn: DEFAULT_CHAINS[964]!.uniswap!.wrappedNative, tokenOut: USDC_964, poolFeeTier: 3000, amountOut: "50000000" } };
}

/** Subtensor EVM -> Ethereum. The mock chain starts with an empty EVM balance at the account's H160. */
function setup(opts: { origin?: MockChainState; body?: unknown } = {}) {
  const origin = mockPublicClient({ nativeBalance: 0n, ...opts.origin });
  const dest = mockPublicClient();
  const fetchMock = vi.fn(async () => jsonResponse(opts.body ?? swapBody()));
  const sdk = new TaoIntents({ fetch: fetchMock as never, publicClients: { 964: origin.client as never, 1: dest.client as never }, now: () => NOW });
  return { sdk, origin, dest, fetchMock };
}

const nativeParams = { originChainId: 964, destinationChainId: 1, inputToken: "TAO", outputToken: "USDC", recipient: RECIPIENT, substrateAccount: COLDKEY_SS58 } as const;
const alphaParams = { originChainId: 964, destinationChainId: 1, inputToken: "SN64", outputToken: "USDC", alphaHotkey: HOTKEY, recipient: RECIPIENT, substrateAccount: COLDKEY_SS58 } as const;

const decodeOpen = (call: SubstrateCall) => {
  const { args } = decodeFunctionData({ abi: intentsAbi, data: call.args[2] as Hex });
  const [order] = args as unknown as [{ orderData: Hex }];
  return decodeAbiParameters(inputOrderDataParams, order.orderData)[0];
};
const methods = (calls: SubstrateCall[]) => calls.map((c) => `${c.section}.${c.method}`);

describe("substrateEvmAddress", () => {
  it("is the first 20 bytes of the public key", () => {
    expect(substrateEvmAddress(COLDKEY_SS58).toLowerCase()).toBe(`0x${COLDKEY.slice(2, 42)}`);
    expect(substrateEvmAddress(COLDKEY)).toBe(SOURCE);
  });

  it("rejects what isn't a Substrate account", () => {
    expect(() => substrateEvmAddress("nope")).toThrow(/SS58/);
  });
});

describe("buildEvmCallBatch", () => {
  const common = {
    coldkey: COLDKEY,
    source: SOURCE,
    mirror: MIRROR_COLDKEY,
    settler: INTENTS,
    openCalldata: "0xabcdef" as Hex,
    gasPriceWei: GAS_PRICE,
    mirrorFreeRao: 0n,
  };
  const hotkey: Hex = `0x${"ab".repeat(32)}`;

  it("funds, opens and sweeps for a native input", () => {
    const batch = buildEvmCallBatch({ ...common, valueWei: 5n * 10n ** 18n });
    expect(methods(batch.calls)).toEqual(["balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    // value (5 TAO) + gas of the doubled 330k limit at 10 gwei + the existential deposit
    const gasRao = (660_000n * GAS_PRICE) / 1_000_000_000n;
    expect(batch.requiredRao).toBe(5_000_000_000n + gasRao + 500n);
    expect(batch.calls[0]!.args).toEqual([MIRROR_COLDKEY, batch.fundRao]);
    expect(batch.fundRao).toBe(batch.requiredRao);
    const open = batch.calls[1]!.args;
    expect(open.slice(0, 6)).toEqual([SOURCE, INTENTS, "0xabcdef", 5n * 10n ** 18n, 660_000n, GAS_PRICE]);
    // The trailing arguments leave the nonce and access lists to the runtime.
    expect(open.slice(6)).toEqual([null, null, [], []]);
    expect(batch.calls[2]!.args).toEqual([SOURCE, batch.sweepRao]);
    // the sweep returns the gas between the assumed use (2 x measured) and the limit
    expect(batch.sweepRao).toBe(((660_000n - 2n * 234_529n) * GAS_PRICE) / 1_000_000_000n);
  });

  it("counts the mirror's existing float towards the funding, and skips it when that is enough", () => {
    const needed = buildEvmCallBatch({ ...common, valueWei: 10n ** 18n }).requiredRao;
    expect(buildEvmCallBatch({ ...common, valueWei: 10n ** 18n, mirrorFreeRao: needed - 7n }).fundRao).toBe(7n);
    const funded = buildEvmCallBatch({ ...common, valueWei: 10n ** 18n, mirrorFreeRao: needed });
    expect(funded.fundRao).toBe(0n);
    expect(methods(funded.calls)).toEqual(["evm.call", "evm.withdraw"]);
  });

  it("appends the attribution suffix to the open calldata", () => {
    const batch = buildEvmCallBatch({ ...common, valueWei: 10n ** 18n, dataSuffix: "0x1234" });
    expect(batch.calls[1]!.args[2]).toBe("0xabcdef1234");
  });

  it("refuses a value that isn't a whole rao", () => {
    expect(() => buildEvmCallBatch({ ...common, valueWei: 10n ** 18n + 1n })).toThrow(/9 decimal/);
  });

  it("moves the stake, funds gas, approves, opens and sweeps for an alpha input", () => {
    const batch = buildEvmCallBatch({
      ...common,
      valueWei: 0n,
      alpha: { netuid: 64, hotkey, alphaRao: 1_000_000_000n, allowanceRao: 0n, stakedRao: 5_000_000_000n },
    });
    expect(methods(batch.calls)).toEqual(["subtensorModule.transferStake", "balances.transferKeepAlive", "evm.call", "evm.call", "evm.withdraw"]);
    // (destination, hotkey, origin netuid, destination netuid, amount + 2 rao of slack)
    expect(batch.calls[0]!.args).toEqual([MIRROR_COLDKEY, hotkey, 64, 64, 1_000_000_002n]);
    const approve = batch.calls[2]!.args;
    expect(approve[1]).toBe(STAKING_PRECOMPILE);
    expect(decodeFunctionData({ abi: stakingAbi, data: approve[2] as Hex })).toMatchObject({ functionName: "approve", args: [INTENTS, 64n, 1_000_000_000n] });
    expect(approve.slice(3)).toEqual([0n, 80_000n, GAS_PRICE, null, null, [], []]);
    // alpha's open gets 2 x 1.3M gas, and the approval's gas is funded on top
    expect(batch.calls[3]!.args[4]).toBe(2_600_000n);
    expect(batch.requiredRao).toBe(((2_600_000n + 80_000n) * GAS_PRICE) / 1_000_000_000n + 500n);
  });

  it("skips the approval the settler already has, and never moves more stake than there is", () => {
    const alpha = { netuid: 64, hotkey, alphaRao: 1_000_000_000n, allowanceRao: 1_000_000_000n, stakedRao: 1_000_000_001n };
    const batch = buildEvmCallBatch({ ...common, valueWei: 0n, alpha });
    expect(methods(batch.calls)).toEqual(["subtensorModule.transferStake", "balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    // 1 rao of headroom: the slack shrinks to fit
    expect(batch.calls[0]!.args[4]).toBe(1_000_000_001n);
    expect(buildEvmCallBatch({ ...common, valueWei: 0n, alpha: { ...alpha, stakedRao: 1_000_000_000n } }).calls[0]!.args[4]).toBe(1_000_000_000n);
  });

  it("refuses to send value with an alpha input", () => {
    expect(() => buildEvmCallBatch({ ...common, valueWei: 10n ** 9n, alpha: { netuid: 1, hotkey, alphaRao: 1n, allowanceRao: 0n, stakedRao: 1n } })).toThrow(/no native value/);
  });

  it("trims a sale of the whole position to leave the rounding slack", () => {
    expect(alphaSellLeavingSlack(10n, 10n)).toBe(8n);
    expect(alphaSellLeavingSlack(5n, 10n)).toBe(5n);
    expect(alphaSellLeavingSlack(11n, 10n)).toBe(11n); // over the position: left to fail as insufficient
    expect(alphaSellLeavingSlack(2n, 2n)).toBe(2n); // too small to spare any
  });

  it("builds an ERC-20 transfer batch", () => {
    const batch = buildEvmCallTransferBatch({ coldkey: COLDKEY, source: SOURCE, mirror: MIRROR_COLDKEY, token: USDC_964, amountRaw: 7n, to: RECIPIENT, gasPriceWei: GAS_PRICE, mirrorFreeRao: 0n });
    expect(methods(batch.calls)).toEqual(["balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: batch.calls[1]!.args[2] as Hex })).toMatchObject({ functionName: "transfer", args: [RECIPIENT, 7n] });
    expect(batch.calls[1]!.args[4]).toBe(200_000n);
    expect(batch.sweepRao).toBe((100_000n * GAS_PRICE) / 1_000_000_000n);
  });
});

describe("getQuote for a Substrate account", () => {
  it("quotes as the account's EVM address", async () => {
    const { sdk, fetchMock } = setup();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    expect(quote).toMatchObject({ user: SOURCE, substrateAccount: COLDKEY, recipient: RECIPIENT, inputKind: "native" });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent).toMatchObject({ userAddress: SOURCE, recipient: RECIPIENT });
  });

  it("names the Substrate account as the source of native TAO, as a `transfer_tao` leg", async () => {
    const { sdk, fetchMock } = setup();
    await sdk.getQuote({ ...nativeParams, amount: "1" });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.subtensor).toEqual({ side: "source", operation: "transfer_tao", recipientColdkey: COLDKEY_SS58, amount: (10n ** 18n).toString() });
  });

  it("needs a recipient: the account's own EVM address has no key", async () => {
    const { sdk } = setup();
    const { recipient: _recipient, ...rest } = nativeParams;
    await expect(sdk.getQuote({ ...rest, amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("`recipient`") });
  });

  it("can't be combined with `user`", async () => {
    await expect(setup().sdk.getQuote({ ...nativeParams, user: USER, amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("not both") });
  });

  it("only takes native and alpha inputs, on a chain that can", async () => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...nativeParams, inputToken: "USDC", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    await expect(sdk.getQuote({ ...nativeParams, inputToken: "wTAO", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    await expect(
      sdk.getQuote({ originChainId: 1, destinationChainId: 964, outputToken: "TAO", recipient: RECIPIENT, substrateAccount: COLDKEY_SS58, amount: "1" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE", message: expect.stringContaining("Ethereum") });
  });

  it("limits native TAO to whole rao", async () => {
    await expect(setup().sdk.getQuote({ ...nativeParams, amount: "0.0000000001" })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("9 decimal") });
  });

  it("rejects a malformed account", async () => {
    await expect(setup().sdk.getQuote({ ...nativeParams, substrateAccount: "nope", amount: "1" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("trims an alpha amount that is the whole stake", async () => {
    const { sdk } = setup({ origin: { stake: 1_000_000_000n } });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    expect(quote.inputAmount).toBe(999_999_998n);
    expect(quote.alphaInput).toMatchObject({ amount: 999_999_998n, coldkey: MIRROR_COLDKEY });
    const keep = await setup({ origin: { stake: 5_000_000_000n } }).sdk.getQuote({ ...alphaParams, amount: "1" });
    expect(keep.inputAmount).toBe(1_000_000_000n);
  });
});

describe("open from a Substrate account", () => {
  it("opens a native-TAO intent with one signed batch", async () => {
    const { sdk, origin } = setup();
    const { signer, signAndSendBatch, spendableAfterFee } = fakeSigner();
    const steps: ProgressEvent[] = [];
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    const result = await sdk.open({ quote, substrate: signer, onProgress: (e) => steps.push(e) });

    expect(signAndSendBatch).toHaveBeenCalledTimes(1);
    const calls = signAndSendBatch.mock.calls[0]![0];
    expect(methods(calls)).toEqual(["balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    expect(spendableAfterFee).toHaveBeenCalledWith(calls);
    // the order's user is the account's EVM address, and the TAO rides as the call's value
    const open = calls[1]!;
    expect(open.args[0]).toBe(SOURCE);
    expect(open.args[1]).toBe(INTENTS);
    expect(open.args[3]).toBe(10n ** 18n);
    expect(decodeOpen(open)).toMatchObject({ user: SOURCE, inputTokenToSwapFrom: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", inputAmountToSwapFrom: 10n ** 18n });
    // simulated from the wrapped native token's address (it holds the TAO), as the user of an otherwise identical order
    const simulated = origin.client.simulateContract.mock.calls.find(([a]) => (a as { functionName: string }).functionName === "open")![0] as { account: Address; value: bigint; args: [{ orderData: Hex }] };
    expect(simulated.account).toBe(WTAO);
    expect(simulated.value).toBe(10n ** 18n);
    expect(decodeAbiParameters(inputOrderDataParams, simulated.args[0].orderData)[0]).toMatchObject({ user: WTAO, inputAmountToSwapFrom: 10n ** 18n });

    expect(result).toMatchObject({ orderId: ORDER_ID, extrinsicHash: `0x${"11".repeat(32)}`, blockHash: `0x${"22".repeat(32)}` });
    expect(result.order).toMatchObject({ orderId: ORDER_ID, originChainId: 964, destinationChainId: 1 });
    expect(result.order.openTxHash).toBeUndefined();
    expect(steps.map((s) => s.step)).toEqual(expect.arrayContaining(["swap-quoted", "awaiting-signature", "substrate-submitted", "substrate-confirmed"]));
    expect(steps.find((s) => s.step === "substrate-confirmed")).toMatchObject({ orderId: ORDER_ID });
  });

  it("opens an alpha intent: stake move, approval, open", async () => {
    const { sdk } = setup({ origin: { stake: 5_000_000_000n } });
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    await sdk.open({ quote, substrate: signer });
    const calls = signAndSendBatch.mock.calls[0]![0];
    expect(methods(calls)).toEqual(["subtensorModule.transferStake", "balances.transferKeepAlive", "evm.call", "evm.call", "evm.withdraw"]);
    expect(calls[0]!.args.slice(0, 4)).toEqual([MIRROR_COLDKEY, quote.alphaInput!.hotkey, 64, 64]);
    expect(calls[0]!.args[4]).toBe(1_000_000_002n);
    // the settler unstakes from the mirror: the order's alpha data names the user's own hotkey, not the coldkey
    expect(decodeOpen(calls[3]!)).toMatchObject({ user: SOURCE, inputTokenToSwapFrom: "0x0000000000000000000000000000000000000000" });
  });

  it("skips the approval and funding that are already in place", async () => {
    const { sdk } = setup({ origin: { stake: 5_000_000_000n, stakeAllowance: 1_000_000_000n, nativeBalance: 10n ** 24n } });
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    await sdk.open({ quote, substrate: signer });
    expect(methods(signAndSendBatch.mock.calls[0]![0])).toEqual(["subtensorModule.transferStake", "evm.call", "evm.withdraw"]);
  });

  it("refuses an alpha input the coldkey doesn't hold, before signing", async () => {
    const { sdk, origin } = setup({ origin: { stake: 5_000_000_000n } });
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    origin.state.stake = 10n;
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", message: expect.stringContaining("SN64 alpha") });
    expect(signAndSendBatch).not.toHaveBeenCalled();
  });

  it("refuses when the coldkey can't cover the funding and fee, before signing", async () => {
    const { sdk } = setup();
    const { signer, signAndSendBatch } = fakeSigner({ spendable: 1_000n });
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", message: expect.stringContaining("TAO") });
    expect(signAndSendBatch).not.toHaveBeenCalled();
  });

  it("refuses before signing when the pre-flight simulation reverts", async () => {
    const { ContractFunctionRevertedError } = await import("viem");
    const { sdk } = setup({ origin: { simulateError: new ContractFunctionRevertedError({ abi: intentsAbi, functionName: "open", message: "x", data: "0x" as Hex }) } });
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "CONTRACT_REVERT" });
    expect(signAndSendBatch).not.toHaveBeenCalled();
  });

  it("goes ahead when the node can't run the pre-flight at all", async () => {
    const { sdk } = setup({ origin: { simulateError: new Error("rpc is down") } });
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await sdk.open({ quote, substrate: signer });
    expect(signAndSendBatch).toHaveBeenCalledTimes(1);
  });

  it("pre-flights an alpha input's swap leg as native TAO, with the expected unstake proceeds", async () => {
    const { sdk, origin } = setup({ origin: { stake: 5_000_000_000n, simProceedsRao: 2_000_000_000n } });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    await sdk.open({ quote, substrate: fakeSigner().signer });
    const simulated = origin.client.simulateContract.mock.calls.find(([a]) => (a as { functionName: string }).functionName === "open")![0] as { account: Address; value: bigint; args: [{ orderData: Hex }] };
    expect(simulated.account).toBe(WTAO);
    expect(simulated.value).toBe(2n * 10n ** 18n);
    expect(decodeAbiParameters(inputOrderDataParams, simulated.args[0].orderData)[0]).toMatchObject({
      user: WTAO,
      inputTokenToSwapFrom: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      inputAmountToSwapFrom: 2n * 10n ** 18n,
      subtensorData: "0x",
    });
  });

  it("names the stake an alpha revert leaves behind, and how to get it back", async () => {
    const { sdk } = setup({ origin: { stake: 5_000_000_000n } });
    const { signer } = fakeSigner({ events: [{ section: "evm", method: "ExecutedFailed", data: [INTENTS] }] as never });
    const quote = await sdk.getQuote({ ...alphaParams, amount: "1" });
    const error = await sdk.open({ quote, substrate: signer }).catch((e) => e);
    expect(error).toMatchObject({ code: "EVM_CALL_FAILED", message: expect.stringContaining("recoverStake"), strandedAlpha: { netuid: 64, hotkey: quote.alphaInput!.hotkey } });
  });

  it("reports an EVM revert inside an otherwise successful batch", async () => {
    const { sdk } = setup();
    const { signer } = fakeSigner({ events: [{ section: "evm", method: "ExecutedFailed", data: [INTENTS] }] as never });
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "EVM_CALL_FAILED", extrinsicHash: `0x${"11".repeat(32)}` });
  });

  it("reports a batch with no Open event", async () => {
    const { sdk } = setup();
    const { signer } = fakeSigner({ events: [{ section: "evm", method: "Executed", data: [INTENTS] }] as never });
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "EVM_CALL_FAILED", message: expect.stringContaining("`Open`") });
  });

  it("ignores another contract's Open event", async () => {
    const { sdk } = setup();
    const events = openedEvents();
    (events[0]!.data[0] as { address: string }).address = RECIPIENT;
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: fakeSigner({ events }).signer })).rejects.toMatchObject({ code: "EVM_CALL_FAILED" });
  });

  it("explains the sweep failing as what a reverted open looks like", async () => {
    const { SubstrateError } = await import("../src");
    const { sdk } = setup();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    const failure = new SubstrateError("token.FundsUnavailable: x", { dispatchError: "token.FundsUnavailable: x", extrinsicHash: `0x${"11".repeat(32)}` });
    await expect(sdk.open({ quote, substrate: fakeSigner({ fail: failure }).signer })).rejects.toMatchObject({ code: "EVM_CALL_FAILED", message: expect.stringContaining("reverted") });
    const other = new SubstrateError("system.CallFiltered", { dispatchError: "system.CallFiltered" });
    await expect(sdk.open({ quote, substrate: fakeSigner({ fail: other }).signer })).rejects.toMatchObject({ code: "SUBSTRATE_ERROR" });
  });

  it("passes a rejected signature through", async () => {
    const { UserRejectedError } = await import("../src");
    const { sdk } = setup();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote, substrate: fakeSigner({ fail: new UserRejectedError() }).signer })).rejects.toMatchObject({ code: "USER_REJECTED" });
  });

  it("refuses a quote that was requested for someone else", async () => {
    const { sdk } = setup();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    const other = fakeSigner({ address: encodeSs58(`0x${"07".repeat(32)}`) });
    await expect(sdk.open({ quote, substrate: other.signer })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("substrateAccount") });
    expect(other.signAndSendBatch).not.toHaveBeenCalled();
  });

  it("can't open an EVM quote, and an EVM wallet can't open a Substrate quote", async () => {
    const { sdk } = setup();
    const evmQuote = await sdk.getQuote({ originChainId: 964, destinationChainId: 1, inputToken: "TAO", outputToken: "USDC", amount: "1", user: USER });
    await expect(sdk.open({ quote: evmQuote, substrate: fakeSigner().signer })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const substrateQuote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote: substrateQuote, wallet: mockWalletClient({ chainId: 964, account: USER }) as never })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("refuses an expired quote and a quote below the minimum", async () => {
    const { sdk } = setup();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await expect(sdk.open({ quote: { ...quote, validUntil: NOW - 1 }, substrate: fakeSigner().signer })).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    await expect(sdk.open({ quote, substrate: fakeSigner().signer, minOutputAmount: quote.outputAmount + 1n })).rejects.toMatchObject({ code: "OUTPUT_BELOW_MINIMUM" });
  });

  it("vetoes a signature that took too long, before anything is broadcast", async () => {
    let now = NOW;
    const origin = mockPublicClient({ nativeBalance: 0n });
    const sdk = new TaoIntents({
      fetch: (async () => jsonResponse(swapBody())) as never,
      publicClients: { 964: origin.client as never, 1: mockPublicClient().client as never },
      now: () => now,
    });
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    const { signer, signAndSendBatch } = fakeSigner();
    // the wallet prompt stays open until the fill window is nearly gone
    signAndSendBatch.mockImplementationOnce(async (_calls, options) => {
      now += 290;
      options?.beforeSubmit?.();
      throw new Error("unreachable");
    });
    await expect(sdk.open({ quote, substrate: signer })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("took too long") });
  });

  it("appends the attribution code to the open call", async () => {
    const { sdk } = setup();
    const { signer, signAndSendBatch } = fakeSigner();
    const quote = await sdk.getQuote({ ...nativeParams, amount: "1" });
    await sdk.open({ quote, substrate: signer, partnerId: "acme" });
    const input = signAndSendBatch.mock.calls[0]![0][1]!.args[2] as Hex;
    expect(input).toContain(Array.from("acme", (c) => c.charCodeAt(0).toString(16)).join(""));
    expect(input.endsWith("80218021802180218021802180218021")).toBe(true);
  });
});

describe("execute from a Substrate account", () => {
  it("quotes for the signer and opens in one call", async () => {
    const { sdk, fetchMock } = setup();
    const { signer, signAndSendBatch } = fakeSigner();
    const { substrateAccount: _a, ...params } = nativeParams;
    const result = await sdk.execute({ ...params, amount: "1", substrate: signer });
    expect(result).toMatchObject({ orderId: ORDER_ID, quote: { user: SOURCE } });
    expect(signAndSendBatch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-quotes when the quote has run out before it is signed", async () => {
    const origin = mockPublicClient({ nativeBalance: 0n });
    let n = 0;
    // the first quote is already out of date when open() looks at it
    const fetchMock = vi.fn(async () => jsonResponse(quoterBodyWithRoute(++n === 1 ? NOW : NOW + 60)));
    const sdk = new TaoIntents({ fetch: fetchMock as never, publicClients: { 964: origin.client as never, 1: mockPublicClient().client as never }, now: () => NOW });
    const { signer, signAndSendBatch } = fakeSigner();
    const events: ProgressEvent[] = [];
    const { substrateAccount: _a, ...params } = nativeParams;
    await sdk.execute({ ...params, amount: "1", substrate: signer, onProgress: (e) => events.push(e) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signAndSendBatch).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ step: "quote-refreshing", reason: "expired" });
  });

  it("holds the output to the slippage limit across re-quotes", async () => {
    const { sdk } = setup();
    const { signer } = fakeSigner();
    const { substrateAccount: _a, ...params } = nativeParams;
    await expect(sdk.execute({ ...params, amount: "1", substrate: signer, minOutputAmount: 10n ** 30n })).rejects.toMatchObject({ code: "OUTPUT_BELOW_MINIMUM" });
  });
});

function quoterBodyWithRoute(validUntil: number) {
  return { ...swapBody(), quote: { ...swapBody().quote, validUntil } };
}

describe("recoverRefund", () => {
  it("moves the USDC held at the account's EVM address out, in one batch", async () => {
    const { sdk } = setup({ origin: { balance: 12_345_678n } });
    const { signer, signAndSendBatch } = fakeSigner({ events: [{ section: "evm", method: "Executed", data: [USDC_964] }] as never });
    const result = await sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT });
    expect(result.amount).toBe(12_345_678n);
    const calls = signAndSendBatch.mock.calls[0]![0];
    expect(methods(calls)).toEqual(["balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    expect(calls[1]!.args.slice(0, 2)).toEqual([SOURCE, USDC_964]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1]!.args[2] as Hex })).toMatchObject({ args: [RECIPIENT, 12_345_678n] });
  });

  it("moves a given amount, and refuses more than is held or nothing at all", async () => {
    const { sdk } = setup({ origin: { balance: 100n } });
    const { signer, signAndSendBatch } = fakeSigner({ events: [{ section: "evm", method: "Executed", data: [] }] as never });
    await expect(sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT, amountRaw: 101n })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT, amountRaw: 40n });
    expect(decodeFunctionData({ abi: erc20Abi, data: signAndSendBatch.mock.calls[0]![0][1]!.args[2] as Hex })).toMatchObject({ args: [RECIPIENT, 40n] });
    await expect(setup({ origin: { balance: 0n } }).sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("reports a reverted transfer", async () => {
    const { sdk } = setup({ origin: { balance: 100n } });
    const { signer } = fakeSigner({ events: [{ section: "evm", method: "ExecutedFailed", data: [] }] as never });
    await expect(sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT })).rejects.toMatchObject({ code: "EVM_CALL_FAILED" });
  });

  it("only moves ERC-20s, on a chain that supports it", async () => {
    const { sdk } = setup();
    const { signer } = fakeSigner();
    await expect(sdk.recoverRefund({ substrate: signer, originChainId: 964, to: RECIPIENT, token: "TAO" })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    await expect(sdk.recoverRefund({ substrate: signer, originChainId: 1, to: RECIPIENT })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
  });
});

describe("recoverStake", () => {
  const hotkey = "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN";

  it("moves the stake parked at the mirror back to the coldkey, as the account's EVM address", async () => {
    const { sdk } = setup({ origin: { stake: 7_000_000_000n } });
    const { signer, signAndSendBatch } = fakeSigner({ events: [{ section: "evm", method: "Executed", data: [] }] as never });
    const result = await sdk.recoverStake({ substrate: signer, originChainId: 964, netuid: 64, hotkey });
    expect(result.amount).toBe(7_000_000_000n);
    const calls = signAndSendBatch.mock.calls[0]![0];
    expect(methods(calls)).toEqual(["balances.transferKeepAlive", "evm.call", "evm.withdraw"]);
    expect(calls[1]!.args.slice(0, 2)).toEqual([SOURCE, STAKING_PRECOMPILE]);
    expect(decodeFunctionData({ abi: stakingAbi, data: calls[1]!.args[2] as Hex })).toMatchObject({
      functionName: "transferStake",
      args: [COLDKEY, expect.any(String), 64n, 64n, 7_000_000_000n],
    });
  });

  it("refuses more than is staked, nothing staked, and a reverted transfer", async () => {
    const { signer } = fakeSigner({ events: [{ section: "evm", method: "ExecutedFailed", data: [] }] as never });
    const { sdk } = setup({ origin: { stake: 100n } });
    await expect(sdk.recoverStake({ substrate: signer, originChainId: 964, netuid: 64, hotkey, amountRaw: 101n })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await expect(sdk.recoverStake({ substrate: signer, originChainId: 964, netuid: 64, hotkey })).rejects.toMatchObject({ code: "EVM_CALL_FAILED" });
    await expect(setup({ origin: { stake: 0n } }).sdk.recoverStake({ substrate: signer, originChainId: 964, netuid: 64, hotkey })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("polkadotSigner", () => {
  /** The bits of polkadot-js the adapter touches, recording what it is asked. */
  function fakeApi(opts: { dispatchError?: unknown; signFails?: Error; status?: "inBlock" | "dropped"; events?: unknown[] } = {}) {
    const signAsync = vi.fn(async (_account: unknown, _options: unknown) => {
      if (opts.signFails) throw opts.signFails;
      return signed;
    });
    const hash = { toHex: () => `0x${"33".repeat(32)}` };
    const blockHash = { toHex: () => `0x${"44".repeat(32)}` };
    const signed = {
      hash,
      send: vi.fn(async (cb: (r: unknown) => void) => {
        const status =
          opts.status === "dropped"
            ? { isInBlock: false, isFinalized: false, isDropped: true, type: "Dropped" }
            : { isInBlock: true, isFinalized: false, asInBlock: blockHash, type: "InBlock" };
        cb({
          status,
          dispatchError: opts.dispatchError,
          events: opts.events ?? [{ event: { section: "evm", method: "Log", data: [{ toJSON: () => ({ address: INTENTS, topics: [OPEN_TOPIC, ORDER_ID] }) }] } }],
        });
        return () => {};
      }),
    };
    const batch = { signAsync, paymentInfo: vi.fn(async () => ({ partialFee: { toString: () => "1000" } })) };
    const calls: Array<{ section: string; method: string; args: unknown[] }> = [];
    const tx: Record<string, Record<string, (...a: unknown[]) => unknown>> = {
      utility: { batchAll: vi.fn((inner: unknown) => ({ ...batch, inner })) },
    };
    for (const [section, method] of [["balances", "transferKeepAlive"], ["evm", "call"], ["evm", "withdraw"], ["subtensorModule", "transferStake"]] as const) {
      (tx[section] ??= {})[method] = (...args: unknown[]) => {
        calls.push({ section, method, args });
        return { section, method };
      };
    }
    const api = {
      tx,
      query: { system: { account: vi.fn(async () => ({ data: { free: { toString: () => "10000" }, frozen: { toString: () => "0" } } })) } },
      registry: { findMetaError: vi.fn(() => ({ section: "evm", name: "WithdrawFailed", docs: ["Withdraw failed"] })) },
    };
    return { api, signAsync, calls, signed };
  }

  it("batches the calls, signs with polkadot-js's default era, and returns the extrinsic's events as JSON", async () => {
    const { api, signAsync, calls } = fakeApi();
    const injected = { signPayload: vi.fn() };
    const signer = polkadotSigner({ api, account: COLDKEY_SS58, signer: injected });
    const order: string[] = [];
    const result = await signer.signAndSendBatch(
      [{ section: "balances", method: "transferKeepAlive", args: ["0xaa", 5n] }, { section: "evm", method: "withdraw", args: [SOURCE, 1n] }],
      { beforeSubmit: () => order.push("beforeSubmit"), onSigned: (h) => order.push(`signed:${h.slice(0, 6)}`) },
    );
    expect(calls.map((c) => `${c.section}.${c.method}`)).toEqual(["balances.transferKeepAlive", "evm.withdraw"]);
    expect(calls[0]!.args).toEqual(["0xaa", 5n]);
    expect(signAsync).toHaveBeenCalledWith(COLDKEY_SS58, expect.objectContaining({ signer: injected, era: 32, nonce: -1, withSignedTransaction: true }));
    expect(order).toEqual(["beforeSubmit", "signed:0x3333"]);
    expect(result).toMatchObject({ extrinsicHash: `0x${"33".repeat(32)}`, blockHash: `0x${"44".repeat(32)}` });
    expect(result.events).toEqual([{ section: "evm", method: "Log", data: [{ address: INTENTS, topics: [OPEN_TOPIC, ORDER_ID] }] }]);
  });

  it("signs with a keyring pair, taking its address", async () => {
    const { api, signAsync } = fakeApi();
    const pair = { address: COLDKEY_SS58 };
    const signer = polkadotSigner({ api, account: pair });
    expect(signer.address).toBe(COLDKEY_SS58);
    await signer.signAndSendBatch([{ section: "evm", method: "withdraw", args: [SOURCE, 1n] }]);
    expect(signAsync.mock.calls[0]![0]).toBe(pair);
    expect(signAsync.mock.calls[0]![1]).not.toHaveProperty("signer");
  });

  it("decodes a dispatch error", async () => {
    const { api } = fakeApi({ dispatchError: { isModule: true, asModule: {} } });
    const signer = polkadotSigner({ api, account: COLDKEY_SS58 });
    await expect(signer.signAndSendBatch([{ section: "evm", method: "withdraw", args: [SOURCE, 1n] }])).rejects.toMatchObject({
      code: "SUBSTRATE_ERROR",
      dispatchError: "evm.WithdrawFailed: Withdraw failed",
      extrinsicHash: `0x${"33".repeat(32)}`,
    });
  });

  it("maps a cancelled signature to a rejection, and other signing failures to a substrate error", async () => {
    const cancelled = polkadotSigner({ api: fakeApi({ signFails: new Error("Cancelled") }).api, account: COLDKEY_SS58 });
    await expect(cancelled.signAndSendBatch([{ section: "evm", method: "withdraw", args: [] }])).rejects.toMatchObject({ code: "USER_REJECTED" });
    const broken = polkadotSigner({ api: fakeApi({ signFails: new Error("1010: bad signature") }).api, account: COLDKEY_SS58 });
    await expect(broken.signAndSendBatch([{ section: "evm", method: "withdraw", args: [] }])).rejects.toMatchObject({ code: "SUBSTRATE_ERROR" });
  });

  it("fails when the extrinsic is dropped, and when the chain lacks a call", async () => {
    const dropped = polkadotSigner({ api: fakeApi({ status: "dropped" }).api, account: COLDKEY_SS58 });
    await expect(dropped.signAndSendBatch([{ section: "evm", method: "withdraw", args: [] }])).rejects.toMatchObject({ code: "SUBSTRATE_ERROR", message: expect.stringContaining("dropped") });
    const signer = polkadotSigner({ api: fakeApi().api, account: COLDKEY_SS58 });
    await expect(signer.signAndSendBatch([{ section: "nope", method: "x", args: [] }])).rejects.toMatchObject({ code: "SUBSTRATE_ERROR", message: expect.stringContaining("nope.x") });
  });

  it("estimates what is spendable after the fee, keeping the existential deposit", async () => {
    const signer = polkadotSigner({ api: fakeApi().api, account: COLDKEY_SS58 });
    // free 10000 - ED 500 - fee 1000
    await expect(signer.spendableAfterFee!([{ section: "evm", method: "withdraw", args: [SOURCE, 1n] }])).resolves.toBe(8_500n);
  });
});
