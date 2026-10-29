import { encodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { SUBTENSOR_OP_ALPHA_STAKE, subtensorDataParams } from "./abi";
import { InvalidParamsError } from "./errors";

/** Subtensor EVM precompiles. */
export const STAKING_PRECOMPILE: Address = "0x0000000000000000000000000000000000000805";
export const ALPHA_PRECOMPILE: Address = "0x0000000000000000000000000000000000000808";
export const ADDRESS_MAPPING_PRECOMPILE: Address = "0x000000000000000000000000000000000000080C";

export const stakingAbi = parseAbi([
  "function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)",
  "function allowance(address sourceAddress, address spenderAddress, uint256 netuid) view returns (uint256)",
  "function approve(address spenderAddress, uint256 netuid, uint256 absoluteAmount)",
  "function transferStake(bytes32 destination_coldkey, bytes32 hotkey, uint256 origin_netuid, uint256 destination_netuid, uint256 amount)",
]);
const alphaAbi = parseAbi(["function simSwapAlphaForTao(uint16 netuid, uint64 alpha) view returns (uint256)"]);
const addressMappingAbi = parseAbi(["function addressMapping(address target_address) view returns (bytes32)"]);

/** 1 rao = 1e9 wei: alpha and `getStake` use rao (9 decimals), native TAO on the EVM uses wei (18). */
const RAO_TO_WEI = 1_000_000_000n;
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * The Substrate coldkey that owns the stake of an EVM address (`HashedAddressMapping`, via the chain's
 * precompile). The settler unstakes from this account, so an alpha input must already sit here.
 */
export function readMirrorColdkey(client: PublicClient, evmAddress: Address): Promise<Hex> {
  return client.readContract({
    address: ADDRESS_MAPPING_PRECOMPILE,
    abi: addressMappingAbi,
    functionName: "addressMapping",
    args: [evmAddress],
  }) as Promise<Hex>;
}

/** Alpha (rao) staked to `hotkey` by `coldkey` on `netuid`. */
export function readStake(client: PublicClient, hotkey: Hex, coldkey: Hex, netuid: number): Promise<bigint> {
  return client.readContract({
    address: STAKING_PRECOMPILE,
    abi: stakingAbi,
    functionName: "getStake",
    args: [hotkey, coldkey, BigInt(netuid)],
  });
}

/** Alpha (rao) of `netuid` that `spender` may still move out of `owner`'s stake. */
export function readStakeAllowance(client: PublicClient, owner: Address, spender: Address, netuid: number): Promise<bigint> {
  return client.readContract({
    address: STAKING_PRECOMPILE,
    abi: stakingAbi,
    functionName: "allowance",
    args: [owner, spender, BigInt(netuid)],
  });
}

/**
 * Native TAO (wei) that unstaking `alphaRao` of `netuid` yields right now, from the chain's own swap
 * simulation. Root stake (netuid 0) has no pool: it unstakes 1:1.
 */
export async function simulateUnstakeProceeds(client: PublicClient, netuid: number, alphaRao: bigint): Promise<bigint> {
  if (alphaRao > MAX_UINT64) throw new InvalidParamsError("The alpha amount is too large to unstake.");
  if (netuid === 0) return alphaRao * RAO_TO_WEI;
  const taoRao = await client.readContract({
    address: ALPHA_PRECOMPILE,
    abi: alphaAbi,
    functionName: "simSwapAlphaForTao",
    args: [netuid, alphaRao],
  });
  return taoRao * RAO_TO_WEI;
}

/**
 * `SubtensorData` for an `AlphaStake` input: which stake the settler unstakes. On the origin side only the
 * subnet, the hotkey the stake sits on and the alpha amount matter; the coldkey is the fill-side field.
 */
export function encodeAlphaStakeInput(args: { netuid: number; hotkey: Hex; coldkey: Hex; alphaRao: bigint }): Hex {
  return encodeAbiParameters(subtensorDataParams, [
    {
      operationType: SUBTENSOR_OP_ALPHA_STAKE,
      netuid: args.netuid,
      delegatorHotkey: args.hotkey,
      recipientColdkey: args.coldkey,
      amount: args.alphaRao,
    },
  ]);
}
