import { encodeFunctionData, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { ChainConfig } from "./config";
import { InvalidParamsError, UnsupportedRouteError } from "./errors";
import { normalizeError } from "./normalize";
import { applySlippage } from "./swap";

/**
 * wst vaults (`wrapped-tao-smart-contracts`): wstTao holds root stake, a wstAlpha vault holds one subnet's alpha.
 * Their ERC-20 balances are 18-decimal token wei, but the vault math (`previewRedeem`, `redeem`...) takes
 * *units*: 1 unit = 1e9 token wei. A remainder below one unit can't be redeemed.
 */
export const WST_TOKEN_WEI_PER_UNIT = 1_000_000_000n;

/** 1 RAO = 1e9 TAO wei. wstTao's `previewRedeem` returns `stakeOut * 1e9`. */
const RAO_TO_WEI = 1_000_000_000n;

/** wstTao pays `stakeOut * 1e9` give or take this much wei (`REDEEM_TAO_DUST`). */
const WSTTAO_REDEEM_TAO_DUST = 1n;

const vaultErrors = [
  "error ZeroUnitsOutstanding()",
  "error VaultInsolvent()",
  "error DepositsPaused()",
  "error HotkeyMigrationPending()",
  "error HotkeyMigrationIncomplete()",
  "error HotkeyMigrationNotReady()",
  "error InsufficientTaoOut(uint256 actual, uint256 minExpected)",
  "error NativeTransferFailed()",
  "error ZeroReceiver()",
  "error AmountBelowMinStake(uint256 actual, uint256 min)",
  "error AmountExceedsUint64(uint256 amount)",
  "error NegligibleAmount(uint256 amount)",
  "error PrecompileCallFailed()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
] as const;

/** wstTao: `previewRedeem` and the native-TAO `redeem`. */
export const wstTaoAbi = parseAbi([
  "function previewRedeem(uint256 units) view returns (uint256 estimatedTaoOut)",
  "function redeem(uint256 units, address receiver, uint256 minStakeToUnstake, uint256 minTaoOut) returns (uint256 taoOut, uint256 stakeUnstaked)",
  "error InsufficientStakeOut(uint256 actual, uint256 minExpected)",
  ...vaultErrors,
]);

/**
 * wstAlpha: only the native-TAO exit (`previewRedeemToTao` / `redeemToTao`). Its plain `redeem` pays alpha to a
 * coldkey and is deliberately not part of this ABI.
 */
export const wstAlphaAbi = parseAbi([
  "function previewRedeemToTao(uint256 units) view returns (uint256 estimatedAlphaOut, uint256 estimatedTaoOut)",
  "function redeemToTao(uint256 units, address receiver, uint256 minTaoOut) returns (uint256 taoOut, uint256 alphaUnstaked)",
  "error TaoRecoveryMode()",
  "error ZeroAlphaOut(uint256 units)",
  "error ZeroTaoOut(uint256 units)",
  "error AlphaRemovedMismatch(uint256 removed, uint256 expected)",
  ...vaultErrors,
]);

export const wstAlphaRegistryAbi = parseAbi(["function vaultFor(uint256 netuid) view returns (address)"]);

/** Which vault to redeem from: wstTao, or the wstAlpha vault of a subnet (`netuid > 0`). */
export type WstVault = "wstTao" | { netuid: number };

interface ResolvedWstVault {
  kind: "wstTao" | "wstAlpha";
  address: Address;
  /** wstAlpha only. */
  netuid?: number;
}

/** What redeeming a wst balance for native TAO is expected to pay, and the floors the transaction enforces. */
export interface WstRedeemEstimate {
  kind: "wstTao" | "wstAlpha";
  chainId: number;
  /** The vault contract the redeem is sent to. */
  vault: Address;
  /** wstAlpha only: the vault's subnet. */
  netuid?: number;
  /** The token-wei balance the estimate was made for. */
  amount: bigint;
  /** Vault units redeemed: `amount / 1e9`. */
  units: bigint;
  /** Token wei left over below one unit (`amount % 1e9`): it stays in the wallet. */
  remainder: bigint;
  /** Native TAO (wei) the vault's preview expects to pay. */
  estimatedTaoOut: bigint;
  /** Floor passed as `minTaoOut`: the estimate minus `slippageBps`. */
  minTaoOut: bigint;
  /** wstTao only: root stake (RAO) the units convert to (`previewRedeem / 1e9`). */
  estimatedStakeOut?: bigint;
  /** wstTao only: floor passed as `minStakeToUnstake`. */
  minStakeToUnstake?: bigint;
  /** wstAlpha only: alpha (rao) sold for the units. */
  estimatedAlphaOut?: bigint;
  slippageBps: number;
}

/** The redeem as a typed contract call (for viem's `simulateContract` / `writeContract`). */
export type WstRedeemContractCall =
  | { address: Address; abi: typeof wstTaoAbi; functionName: "redeem"; args: readonly [bigint, Address, bigint, bigint] }
  | { address: Address; abi: typeof wstAlphaAbi; functionName: "redeemToTao"; args: readonly [bigint, Address, bigint] };

/** A transaction ready to send: no value, from the wallet holding the wst tokens. */
export interface WstRedeemCall {
  to: Address;
  data: Hex;
  value: 0n;
}

/** Split a token-wei balance into whole vault units and the unredeemable remainder. */
export function tokenWeiToUnits(amount: bigint): { units: bigint; remainder: bigint } {
  if (amount < 0n) throw new InvalidParamsError("The wst amount can't be negative.");
  return { units: amount / WST_TOKEN_WEI_PER_UNIT, remainder: amount % WST_TOKEN_WEI_PER_UNIT };
}

/**
 * Find the vault contract: the chain's `wstTao`, or for a subnet the on-chain `wstAlphaRegistry.vaultFor(netuid)`.
 * `vaultFor(0)` is never asked: root stake is wstTao, which the registry doesn't index.
 */
async function resolveWstVault(client: PublicClient, chain: ChainConfig, vault: WstVault): Promise<ResolvedWstVault> {
  if (vault === "wstTao") {
    if (!chain.wstTao) throw new UnsupportedRouteError(`wstTao is not deployed on ${chain.name} (set \`chains[${chain.id}].wstTao\` to use one).`);
    return { kind: "wstTao", address: chain.wstTao };
  }
  const netuid = vault?.netuid;
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 0xffff) {
    throw new InvalidParamsError("`vault.netuid` must be an integer between 1 and 65535.");
  }
  if (netuid === 0) {
    throw new InvalidParamsError("Root stake (netuid 0) is wstTao, not a wstAlpha vault: pass `vault: \"wstTao\"`.");
  }
  if (!chain.wstAlphaRegistry) {
    throw new UnsupportedRouteError(`wstAlpha is not deployed on ${chain.name} (set \`chains[${chain.id}].wstAlphaRegistry\` to use one).`);
  }
  let address: Address;
  try {
    address = await client.readContract({
      address: chain.wstAlphaRegistry,
      abi: wstAlphaRegistryAbi,
      functionName: "vaultFor",
      args: [BigInt(netuid)],
    });
  } catch (error) {
    throw normalizeError(error, `look up the wstAlpha vault for subnet ${netuid}`);
  }
  if (isAddressEqual(address, zeroAddress)) {
    throw new UnsupportedRouteError(`There is no wstAlpha vault for subnet ${netuid} on ${chain.name}.`);
  }
  return { kind: "wstAlpha", address, netuid };
}

/**
 * Estimate a native-TAO redeem from the vault's own preview and derive the transaction's floors from it. A preview
 * that reverts (paused, recovering, insolvent, empty vault...) is thrown as `ContractRevertError`; a zero estimate
 * is refused rather than returned.
 */
export async function estimateWstRedeem(
  client: PublicClient,
  chain: ChainConfig,
  args: { vault: WstVault; amount: bigint; slippageBps: number },
): Promise<WstRedeemEstimate> {
  const { amount, slippageBps } = args;
  if (typeof amount !== "bigint" || amount <= 0n) throw new InvalidParamsError("`amount` must be a positive bigint (token wei).");
  const { units, remainder } = tokenWeiToUnits(amount);
  if (units === 0n) {
    throw new InvalidParamsError(`The amount is below one vault unit (${WST_TOKEN_WEI_PER_UNIT} token wei) and can't be redeemed.`);
  }
  const vault = await resolveWstVault(client, chain, args.vault);
  const base = { kind: vault.kind, chainId: chain.id, vault: vault.address, amount, units, remainder, slippageBps };

  if (vault.kind === "wstTao") {
    let estimatedTaoOut: bigint;
    try {
      estimatedTaoOut = await client.readContract({ address: vault.address, abi: wstTaoAbi, functionName: "previewRedeem", args: [units] });
    } catch (error) {
      throw normalizeError(error, "estimate the wstTao redeem");
    }
    // The preview is `stakeOut * 1e9`, so the stake divides out exactly.
    const estimatedStakeOut = estimatedTaoOut / RAO_TO_WEI;
    if (estimatedStakeOut === 0n) throw new InvalidParamsError("The wstTao vault estimates 0 TAO for this amount. Nothing to redeem.");
    // A partial exit may pay up to 1 wei under `stakeOut * 1e9`; keep the floor below that even at 0 slippage.
    const minTaoOut = min(applySlippage(estimatedTaoOut, slippageBps), estimatedTaoOut - WSTTAO_REDEEM_TAO_DUST);
    return {
      ...base,
      estimatedTaoOut,
      minTaoOut,
      estimatedStakeOut,
      minStakeToUnstake: applySlippage(estimatedStakeOut, slippageBps),
    };
  }

  let estimatedAlphaOut: bigint;
  let estimatedTaoOut: bigint;
  try {
    [estimatedAlphaOut, estimatedTaoOut] = await client.readContract({
      address: vault.address,
      abi: wstAlphaAbi,
      functionName: "previewRedeemToTao",
      args: [units],
    });
  } catch (error) {
    throw normalizeError(error, `estimate the SN${vault.netuid} wstAlpha redeem`);
  }
  if (estimatedTaoOut === 0n) {
    throw new InvalidParamsError(`The SN${vault.netuid} wstAlpha vault estimates 0 TAO for this amount. Nothing to redeem.`);
  }
  return {
    ...base,
    netuid: vault.netuid,
    estimatedTaoOut,
    minTaoOut: applySlippage(estimatedTaoOut, slippageBps),
    estimatedAlphaOut,
  };
}

/** The redeem an estimate describes, paying native TAO to `receiver` (a Subtensor EVM address). */
export function wstRedeemContractCall(estimate: WstRedeemEstimate, receiver: Address): WstRedeemContractCall {
  if (estimate.minTaoOut <= 0n) throw new InvalidParamsError("`minTaoOut` must be greater than zero.");
  if (estimate.kind === "wstAlpha") {
    return { address: estimate.vault, abi: wstAlphaAbi, functionName: "redeemToTao", args: [estimate.units, receiver, estimate.minTaoOut] };
  }
  if (estimate.minStakeToUnstake === undefined || estimate.minStakeToUnstake <= 0n) {
    throw new InvalidParamsError("A wstTao redeem needs a `minStakeToUnstake` greater than zero.");
  }
  return {
    address: estimate.vault,
    abi: wstTaoAbi,
    functionName: "redeem",
    args: [estimate.units, receiver, estimate.minStakeToUnstake, estimate.minTaoOut],
  };
}

/** Calldata for the redeem an estimate describes, paying native TAO to `receiver` (a Subtensor EVM address). */
export function encodeWstRedeem(estimate: WstRedeemEstimate, receiver: Address): WstRedeemCall {
  const call = wstRedeemContractCall(estimate, receiver);
  const data = call.functionName === "redeem" ? encodeFunctionData(call) : encodeFunctionData(call);
  return { to: call.address, data, value: 0n };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
