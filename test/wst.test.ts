import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { TaoIntents, tokenWeiToUnits, wstAlphaAbi, wstTaoAbi } from "../src";
import { buildChains } from "../src/config";
import { mockWalletClient, USER } from "./helpers";

const WST_TAO: Address = "0x1c6787ED806829d1b5168C96640c7D8953D67d54";
const REGISTRY: Address = "0x7B7e6A58C3A634e459eA5cb458f5581b781Ed945";
const SN64_VAULT: Address = "0x6464646464646464646464646464646464646464";
const RECEIVER: Address = "0x2222222222222222222222222222222222222222";
const E9 = 1_000_000_000n;

interface MockState {
  /** wstTao `previewRedeem(units)`, or an error to throw. */
  previewRedeem?: (units: bigint) => bigint;
  /** wstAlpha `previewRedeemToTao(units)`. */
  previewRedeemToTao?: (units: bigint) => readonly [bigint, bigint];
  vaults?: Record<number, Address>;
  readError?: unknown;
  balance?: bigint;
  simulateError?: unknown;
}

/** A Subtensor EVM client that answers the vault and registry views like the contracts do. */
function mockClient(state: MockState = {}) {
  const s = {
    // ~1.037 RAO per unit, so units, RAO and wei can't be confused.
    previewRedeem: (units: bigint) => ((units * 1_037_000_011n) / 1_000_000_007n) * E9,
    previewRedeemToTao: (units: bigint) => [units * 2n, units * 2n * 3n * E9] as const,
    vaults: { 64: SN64_VAULT } as Record<number, Address>,
    balance: 10n ** 24n,
    ...state,
  };
  return {
    state: s,
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (s.readError) throw s.readError;
      switch (functionName) {
        case "previewRedeem": return s.previewRedeem(args![0] as bigint);
        case "previewRedeemToTao": return s.previewRedeemToTao(args![0] as bigint);
        case "vaultFor": return s.vaults[Number(args![0])] ?? zeroAddress;
        case "balanceOf": return s.balance;
        default: throw new Error(`unexpected read ${functionName}`);
      }
    }),
    simulateContract: vi.fn(async (_call: { account: Address; address: Address; functionName: string; args: readonly unknown[] }) => {
      if (s.simulateError) throw s.simulateError;
      return {};
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: `0x${string}` }) => ({ status: "success" as const, transactionHash: hash, logs: [] })),
  };
}

function setup(state: MockState = {}, chain: { wstTao?: Address; wstAlphaRegistry?: Address } = { wstTao: WST_TAO, wstAlphaRegistry: REGISTRY }) {
  const client = mockClient(state);
  const sdk = new TaoIntents({ chains: { 964: chain }, publicClients: { 964: client as never } });
  return { sdk, client };
}

function revert(abi: Abi, functionName: string, errorName: string, args?: readonly unknown[]) {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  return new BaseError("execution reverted", { cause: new ContractFunctionRevertedError({ abi, functionName, data }) });
}

describe("tokenWeiToUnits", () => {
  it("divides token wei by 1e9 and keeps the sub-unit remainder", () => {
    expect(tokenWeiToUnits(5n * 10n ** 18n + 123n)).toEqual({ units: 5n * E9, remainder: 123n });
    expect(tokenWeiToUnits(E9 - 1n)).toEqual({ units: 0n, remainder: E9 - 1n });
    expect(tokenWeiToUnits(E9)).toEqual({ units: 1n, remainder: 0n });
  });
});

describe("chain wst addresses", () => {
  it("default to the mainnet deploy on 964", () => {
    expect(buildChains()[964]).toMatchObject({
      wstTao: "0xF3007b375F37908D7A9893Cfbf5DA0603c72e2B8",
      wstAlphaRegistry: "0xE9A3Ae35c33cA6D86B464aD5DD177911cEe46Bd3",
    });
  });

  it("are chain config constants a caller can override", () => {
    expect(buildChains({ 964: { wstTao: WST_TAO, wstAlphaRegistry: REGISTRY } })[964]).toMatchObject({ wstTao: WST_TAO, wstAlphaRegistry: REGISTRY });
  });
});

describe("estimateWstRedeem: wstTao", () => {
  it("converts to units, previews, and derives both mins from the estimate", async () => {
    const { sdk, client } = setup();
    const amount = 5n * 10n ** 18n + 123n;
    const est = await sdk.estimateWstRedeem({ vault: "wstTao", amount, slippageBps: 50 });

    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: WST_TAO, functionName: "previewRedeem", args: [5n * E9] }));
    const stake = (5n * E9 * 1_037_000_011n) / 1_000_000_007n;
    expect(est).toMatchObject({
      kind: "wstTao",
      chainId: 964,
      vault: WST_TAO,
      amount,
      units: 5n * E9,
      remainder: 123n,
      estimatedTaoOut: stake * E9,
      estimatedStakeOut: stake,
      minStakeToUnstake: stake - (stake * 50n) / 10_000n,
      minTaoOut: stake * E9 - (stake * E9 * 50n) / 10_000n,
      slippageBps: 50,
    });
  });

  it("defaults to 1% slippage and never sends 0 as a minimum", async () => {
    const { sdk } = setup();
    const est = await sdk.estimateWstRedeem({ vault: "wstTao", amount: 10n ** 18n });
    expect(est.slippageBps).toBe(100);
    expect(est.minTaoOut).toBe(est.estimatedTaoOut - est.estimatedTaoOut / 100n);
    expect(est.minStakeToUnstake).toBe(est.estimatedStakeOut! - est.estimatedStakeOut! / 100n);
  });

  it("at 0 slippage leaves room for the vault's 1 wei payout dust", async () => {
    const { sdk } = setup();
    const est = await sdk.estimateWstRedeem({ vault: "wstTao", amount: 10n ** 18n, slippageBps: 0 });
    expect(est.minStakeToUnstake).toBe(est.estimatedStakeOut);
    expect(est.minTaoOut).toBe(est.estimatedTaoOut - 1n);
  });

  it("encodes redeem(units, receiver, minStakeToUnstake, minTaoOut)", async () => {
    const { sdk } = setup();
    const est = await sdk.estimateWstRedeem({ vault: "wstTao", amount: 3n * 10n ** 18n });
    const call = sdk.encodeWstRedeem(est, RECEIVER);
    expect(call.to).toBe(WST_TAO);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: wstTaoAbi, data: call.data });
    expect(decoded.functionName).toBe("redeem");
    expect(decoded.args).toEqual([3n * E9, RECEIVER, est.minStakeToUnstake, est.minTaoOut]);
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector("redeem(uint256,address,uint256,uint256)"));
  });

  it("refuses to encode a 0 minTaoOut or a missing minStakeToUnstake", async () => {
    const { sdk } = setup();
    const est = await sdk.estimateWstRedeem({ vault: "wstTao", amount: 10n ** 18n });
    expect(() => sdk.encodeWstRedeem({ ...est, minTaoOut: 0n }, RECEIVER)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    expect(() => sdk.encodeWstRedeem({ ...est, minStakeToUnstake: undefined }, RECEIVER)).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
    expect(() => sdk.encodeWstRedeem({ ...est, minStakeToUnstake: 0n }, RECEIVER)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  });

  it("refuses when the chain has no wstTao", async () => {
    const client = mockClient({});
    const sdk = new TaoIntents({ publicClients: { 1: client as never } });
    await expect(sdk.estimateWstRedeem({ chainId: 1, vault: "wstTao", amount: 10n ** 18n })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("surfaces a reverting preview as an error instead of a 0 estimate", async () => {
    const { sdk } = setup({ readError: revert(wstTaoAbi, "previewRedeem", "VaultInsolvent") });
    await expect(sdk.estimateWstRedeem({ vault: "wstTao", amount: 10n ** 18n })).rejects.toMatchObject({
      code: "CONTRACT_REVERT",
      errorName: "VaultInsolvent",
    });
  });

  it("refuses a 0 estimate", async () => {
    const { sdk } = setup({ previewRedeem: () => 0n });
    await expect(sdk.estimateWstRedeem({ vault: "wstTao", amount: 10n ** 18n })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("refuses an amount below one unit", async () => {
    const { sdk, client } = setup();
    await expect(sdk.estimateWstRedeem({ vault: "wstTao", amount: E9 - 1n })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

describe("estimateWstRedeem: wstAlpha", () => {
  it("resolves the vault with vaultFor(netuid) and previews redeemToTao", async () => {
    const { sdk, client } = setup();
    const est = await sdk.estimateWstRedeem({ vault: { netuid: 64 }, amount: 7n * 10n ** 18n + 5n, slippageBps: 200 });

    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: REGISTRY, functionName: "vaultFor", args: [64n] }));
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: SN64_VAULT, functionName: "previewRedeemToTao", args: [7n * E9] }),
    );
    const tao = 7n * E9 * 6n * E9;
    expect(est).toMatchObject({
      kind: "wstAlpha",
      vault: SN64_VAULT,
      netuid: 64,
      units: 7n * E9,
      remainder: 5n,
      estimatedAlphaOut: 14n * E9,
      estimatedTaoOut: tao,
      minTaoOut: tao - (tao * 200n) / 10_000n,
    });
    expect(est.minStakeToUnstake).toBeUndefined();
  });

  it("encodes redeemToTao(units, receiver, minTaoOut), never the alpha-out redeem", async () => {
    const { sdk } = setup();
    const est = await sdk.estimateWstRedeem({ vault: { netuid: 64 }, amount: 10n ** 18n });
    const call = sdk.encodeWstRedeem(est, RECEIVER);
    expect(call.to).toBe(SN64_VAULT);
    const decoded = decodeFunctionData({ abi: wstAlphaAbi, data: call.data });
    expect(decoded.functionName).toBe("redeemToTao");
    expect(decoded.args).toEqual([E9, RECEIVER, est.minTaoOut]);
    expect(wstAlphaAbi.map((item) => ("name" in item ? item.name : "")) as string[]).not.toContain("redeem");
  });

  it("never asks vaultFor(0): root stake is wstTao", async () => {
    const { sdk, client } = setup();
    await expect(sdk.estimateWstRedeem({ vault: { netuid: 0 }, amount: 10n ** 18n })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it.each([65_536, 1.5, -1])("refuses netuid %s without reading the registry", async (netuid) => {
    const { sdk, client } = setup();
    await expect(sdk.estimateWstRedeem({ vault: { netuid }, amount: 10n ** 18n })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("refuses when the chain has no wstAlphaRegistry", async () => {
    const client = mockClient();
    const sdk = new TaoIntents({ publicClients: { 1: client as never } });
    await expect(sdk.estimateWstRedeem({ chainId: 1, vault: { netuid: 64 }, amount: 10n ** 18n })).rejects.toMatchObject({
      code: "UNSUPPORTED_ROUTE",
    });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("wraps a failing registry read in an SDK error", async () => {
    const { sdk } = setup({ readError: new BaseError("RPC unavailable") });
    await expect(sdk.estimateWstRedeem({ vault: { netuid: 64 }, amount: 10n ** 18n })).rejects.toMatchObject({ code: "WALLET_ERROR" });
  });

  it("refuses a subnet the registry has no vault for", async () => {
    const { sdk } = setup();
    await expect(sdk.estimateWstRedeem({ vault: { netuid: 12 }, amount: 10n ** 18n })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
  });

  it("surfaces a vault in recovery as an error", async () => {
    const { sdk, client } = setup();
    client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "vaultFor") return SN64_VAULT;
      throw revert(wstAlphaAbi, "previewRedeemToTao", "TaoRecoveryMode");
    });
    await expect(sdk.estimateWstRedeem({ vault: { netuid: 64 }, amount: 10n ** 18n })).rejects.toMatchObject({
      code: "CONTRACT_REVERT",
      errorName: "TaoRecoveryMode",
    });
  });

  it("refuses a 0 TAO estimate", async () => {
    const { sdk } = setup({ previewRedeemToTao: () => [5n, 0n] as const });
    await expect(sdk.estimateWstRedeem({ vault: { netuid: 64 }, amount: 10n ** 18n })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("wstRedeem", () => {
  it("simulates and sends the redeem to the connected account, then stops at the receipt", async () => {
    const { sdk, client } = setup();
    const wallet = mockWalletClient({ chainId: 964 });
    const steps: string[] = [];
    const result = await sdk.wstRedeem({ wallet: wallet as never, vault: "wstTao", amount: 2n * 10n ** 18n, onProgress: (e) => steps.push(e.step) });

    expect(result.receiver).toBe(USER);
    const sent = wallet.writeContract.mock.calls[0]![0] as { address: Address; functionName: string; args: unknown[] };
    expect(sent.address).toBe(WST_TAO);
    expect(sent.functionName).toBe("redeem");
    expect(sent.args).toEqual([2n * E9, USER, result.estimate.minStakeToUnstake, result.estimate.minTaoOut]);
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ account: USER, address: sent.address, functionName: sent.functionName, args: sent.args });
    expect(steps).toEqual(["switching-chain", "checking-balance", "awaiting-signature", "submitted", "redeem-confirmed"]);
  });

  it("sends redeemToTao to the given receiver for wstAlpha", async () => {
    const { sdk } = setup();
    const wallet = mockWalletClient({ chainId: 964 });
    await sdk.wstRedeem({ wallet: wallet as never, vault: { netuid: 64 }, amount: 10n ** 18n, receiver: RECEIVER });
    const sent = wallet.writeContract.mock.calls[0]![0] as { address: Address; functionName: string; args: unknown[] };
    expect(sent.address).toBe(SN64_VAULT);
    expect(sent.functionName).toBe("redeemToTao");
    expect(sent.args[1]).toBe(RECEIVER);
  });

  it("checks the wst balance before signing", async () => {
    const { sdk } = setup({ balance: 10n ** 17n });
    const wallet = mockWalletClient({ chainId: 964 });
    await expect(sdk.wstRedeem({ wallet: wallet as never, vault: "wstTao", amount: 10n ** 18n })).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
    });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("only needs the whole units in the wallet, not the sub-unit remainder", async () => {
    const { sdk } = setup({ balance: 10n ** 18n });
    const wallet = mockWalletClient({ chainId: 964 });
    const result = await sdk.wstRedeem({ wallet: wallet as never, vault: "wstTao", amount: 10n ** 18n + 5n });
    expect(result.estimate.remainder).toBe(5n);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);

    const short = setup({ balance: 10n ** 18n - 1n });
    await expect(short.sdk.wstRedeem({ wallet: mockWalletClient({ chainId: 964 }) as never, vault: "wstTao", amount: 10n ** 18n + 5n })).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
    });
  });

  it("does not send when the simulation reverts", async () => {
    const { sdk } = setup({ simulateError: revert(wstTaoAbi, "redeem", "HotkeyMigrationPending") });
    const wallet = mockWalletClient({ chainId: 964 });
    await expect(sdk.wstRedeem({ wallet: wallet as never, vault: "wstTao", amount: 10n ** 18n })).rejects.toMatchObject({
      code: "CONTRACT_REVERT",
      errorName: "HotkeyMigrationPending",
    });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });
});
