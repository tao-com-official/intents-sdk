import { bytesToHex, concatHex, encodeFunctionData, erc20Abi, getAbiItem, getAddress, getEventSelector, hexToBytes, type Address, type Hex } from "viem";
import { intentsAbi } from "./abi";
import { STAKING_PRECOMPILE, stakingAbi } from "./alpha";
import { EvmCallFailedError, InvalidParamsError } from "./errors";
import { parseSubstrateAddress } from "./substrate";
import type { SubstrateCall, SubstrateEvent } from "./substrate-signer";

/**
 * Opening an intent from a Substrate account, with no EVM signature.
 *
 * A Substrate coldkey can drive the EVM through `evm.call`, acting as the H160 made of the first 20 bytes of
 * its public key. One `utility.batchAll`, signed once by the coldkey, then does everything `open` needs:
 * moves the alpha to the H160's mirror account (alpha), funds the H160 with the TAO it spends (native) and
 * pays for gas, approves the settler (alpha), calls `open`, and sweeps the unused gas back to the coldkey.
 */

/** 1 rao = 1e9 wei: `evm.call`'s value is wei, balances and the funding transfers are rao. */
const DECIMAL_GAP = 1_000_000_000n;
/** Subtensor's existential deposit. The mirror is never swept below it, so it isn't reaped on every swap. */
const EXISTENTIAL_DEPOSIT_RAO = 500n;
/** Mortal-era length of the extrinsic, in blocks (~51 min). A wallet may take minutes to show a batch it can't decode. */
export const EVM_CALL_ERA_PERIOD = 256;

/**
 * Gas limits. `open` is given twice the gas it needs ("headroom"): the EVM forwards only 63/64 of the gas it
 * has left to each sub-call, so a limit near consumption starves the staking precompile call inside `open`.
 * The alpha figure is the lowest value proven on mainnet; don't lower it towards consumption.
 */
const NATIVE_OPEN_GAS = 330_000n;
const ALPHA_OPEN_GAS = 1_300_000n;
const STAKE_APPROVE_GAS = 40_000n;
const ERC20_TRANSFER_GAS = 100_000n;
const GAS_LIMIT_HEADROOM = 2n;
/** Gas a successful `open` actually used, measured on mainnet. */
const MEASURED_NATIVE_GAS = 234_529n;
const MEASURED_ALPHA_GAS = 460_000n;
/** The sweep assumes this multiple of the measured gas: above real use, well below the limit. */
const SWEEP_GAS_SAFETY_FACTOR = 2n;
/**
 * The stake moved to the mirror carries this many rao more than the order needs: the mirror can read back a
 * rao light of what was credited to it, and the settler asks the staking precompile for the exact amount.
 */
export const ALPHA_ROUNDING_SLACK_RAO = 2n;

/** `evm.Log` topic of the Intents contract's `Open` event. */
const OPEN_TOPIC = getEventSelector(getAbiItem({ abi: intentsAbi, name: "Open" }));

/** The EVM address a Substrate account acts as under `evm.call`: the first 20 bytes of its public key. */
export function evmAddressOfAccountId(accountId: Hex): Address {
  return getAddress(bytesToHex(hexToBytes(accountId).subarray(0, 20)));
}

/**
 * The EVM address an intent opened by this Substrate account (SS58 or 32-byte `0x` AccountId32) carries as its
 * `user`. It has no private key: it is only ever driven through `evm.call`. Refunds of unfilled orders are
 * paid to it (see `recoverRefund`).
 */
export function substrateEvmAddress(account: string): Address {
  const parsed = parseSubstrateAddress(account);
  if (!parsed) throw new InvalidParamsError("A Substrate account must be an SS58 address or a 32-byte `0x` AccountId32.");
  return evmAddressOfAccountId(parsed.accountId);
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Whole rao in `wei`, rounded down. */
export function weiToRao(wei: bigint): bigint {
  return wei / DECIMAL_GAP;
}

/**
 * The alpha an order may sell so that the stake move keeps `ALPHA_ROUNDING_SLACK_RAO` of headroom: the amount
 * asked for, trimmed when it is (nearly) the whole position. Unchanged when the position is unknown or too
 * small to spare any, and when the amount exceeds it (that is an insufficient balance, not a rounding issue).
 */
export function alphaSellLeavingSlack(amountRao: bigint, stakedRao: bigint): bigint {
  if (stakedRao <= ALPHA_ROUNDING_SLACK_RAO || amountRao > stakedRao) return amountRao;
  return min(amountRao, stakedRao - ALPHA_ROUNDING_SLACK_RAO);
}

export interface EvmCallBatchArgs {
  /** The Substrate coldkey signing the batch (32-byte hex). */
  coldkey: Hex;
  /** `evm.call`'s `source`: `evmAddressOfAccountId(coldkey)`. Must equal the order's `user`. */
  source: Address;
  /** The account backing `source`'s EVM balance and stake (32-byte hex): what `source` maps to. */
  mirror: Hex;
  settler: Address;
  /** `open`'s calldata, before any attribution suffix. */
  openCalldata: Hex;
  /** ERC-8021 suffix appended to `openCalldata`. */
  dataSuffix?: Hex;
  /** `msg.value` of `open` in wei: the amount for a native input, 0 for alpha. */
  valueWei: bigint;
  gasPriceWei: bigint;
  /** The mirror's current free balance (rao): float left by an earlier batch counts towards the funding. */
  mirrorFreeRao: bigint;
  /** Alpha input only. */
  alpha?: {
    netuid: number;
    hotkey: Hex;
    alphaRao: bigint;
    /** What the settler may already move out of `source`'s stake on this subnet. */
    allowanceRao: bigint;
    /** What the coldkey stakes to `hotkey` on `netuid`; bounds the rounding slack. */
    stakedRao: bigint;
  };
}

export interface EvmCallBatch {
  calls: SubstrateCall[];
  /** Rao the funding transfer moves to the mirror; 0 when its float already covers the call. */
  fundRao: bigint;
  /** What the mirror must hold before the `open` call. */
  requiredRao: bigint;
  /** Rao the closing sweep returns to the coldkey. */
  sweepRao: bigint;
}

function transferStakeCall(to: Hex, hotkey: Hex, netuid: number, amountRao: bigint): SubstrateCall {
  // (destinationColdkey, hotkey, originNetuid, destinationNetuid, alphaAmount)
  return { section: "subtensorModule", method: "transferStake", args: [to, hotkey, netuid, netuid, amountRao] };
}

function evmCall(source: Address, target: Address, input: Hex, valueWei: bigint, gasLimit: bigint, maxFeePerGas: bigint): SubstrateCall {
  // (source, target, input, value, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, nonce, access_list, authorization_list)
  // The trailing four are resolved by the runtime: the nonce is the source's current one, the lists are empty.
  return { section: "evm", method: "call", args: [source, target, input, valueWei, gasLimit, maxFeePerGas, null, null, [], []] };
}

/** Funding and sweep sizes. The sweep is what makes the batch atomic: see `buildEvmCallBatch`. */
function gasPlan(a: { valueWei: bigint; gasLimit: bigint; assumedGas: bigint; gasPriceWei: bigint; mirrorFreeRao: bigint }) {
  const requiredRao = ceilDiv(a.valueWei, DECIMAL_GAP) + ceilDiv(a.gasLimit * a.gasPriceWei, DECIMAL_GAP) + EXISTENTIAL_DEPOSIT_RAO;
  return {
    requiredRao,
    fundRao: a.mirrorFreeRao >= requiredRao ? 0n : requiredRao - a.mirrorFreeRao,
    sweepRao: a.gasLimit > a.assumedGas ? ((a.gasLimit - a.assumedGas) * a.gasPriceWei) / DECIMAL_GAP : 0n,
  };
}

/**
 * The ordered calls of the batch that opens one intent.
 *
 * Native input: fund the mirror (amount + gas), `open`, sweep. Alpha input: move the stake to the mirror,
 * fund gas, approve the settler on the staking precompile (skipped if already allowed), `open`, sweep.
 *
 * The closing sweep returns the unused gas, and is also what makes the batch atomic: `evm.call` succeeds as an
 * extrinsic even when the EVM call inside it reverts, so without a last call that can fail, a reverting `open`
 * would leave the alpha parked at the mirror while the batch reported success. A revert burns the whole gas
 * limit; sizing the sweep above real usage but well below the limit means a normal run gets its gas back
 * and a reverting one leaves too little, taking the whole batch down. A native input can't rely on this: a
 * reverted call hands its `msg.value` back, so the sweep still clears. Those are caught from the
 * `evm.ExecutedFailed` event instead (`readOpenedOrder`).
 */
export function buildEvmCallBatch(a: EvmCallBatchArgs): EvmCallBatch {
  // Funding and sweep are in rao, `evm.call`'s value in wei: a value that isn't a whole rao would be
  // truncated and escrow less than shown.
  if (a.valueWei % DECIMAL_GAP !== 0n) {
    throw new InvalidParamsError("TAO paid from a Substrate account is limited to 9 decimal places (whole rao).");
  }
  if (a.alpha && a.valueWei !== 0n) throw new InvalidParamsError("An alpha input sends no native value.");

  const openGas = (a.alpha ? ALPHA_OPEN_GAS : NATIVE_OPEN_GAS) * GAS_LIMIT_HEADROOM;
  const needsApprove = !!a.alpha && a.alpha.allowanceRao < a.alpha.alphaRao;
  const approveGas = needsApprove ? STAKE_APPROVE_GAS * GAS_LIMIT_HEADROOM : 0n;
  const { requiredRao, fundRao, sweepRao } = gasPlan({
    valueWei: a.valueWei,
    gasLimit: openGas + approveGas,
    assumedGas: (a.alpha ? MEASURED_ALPHA_GAS : MEASURED_NATIVE_GAS) * SWEEP_GAS_SAFETY_FACTOR,
    gasPriceWei: a.gasPriceWei,
    mirrorFreeRao: a.mirrorFreeRao,
  });

  const calls: SubstrateCall[] = [];
  if (a.alpha) {
    const headroom = a.alpha.stakedRao > a.alpha.alphaRao ? a.alpha.stakedRao - a.alpha.alphaRao : 0n;
    const slack = min(ALPHA_ROUNDING_SLACK_RAO, headroom);
    calls.push(transferStakeCall(a.mirror, a.alpha.hotkey, a.alpha.netuid, a.alpha.alphaRao + slack));
  }
  if (fundRao > 0n) calls.push({ section: "balances", method: "transferKeepAlive", args: [a.mirror, fundRao] });
  if (needsApprove && a.alpha) {
    calls.push(
      evmCall(
        a.source,
        STAKING_PRECOMPILE,
        encodeFunctionData({ abi: stakingAbi, functionName: "approve", args: [a.settler, BigInt(a.alpha.netuid), a.alpha.alphaRao] }),
        0n,
        approveGas,
        a.gasPriceWei,
      ),
    );
  }
  calls.push(evmCall(a.source, a.settler, concatHex([a.openCalldata, a.dataSuffix ?? "0x"]), a.valueWei, openGas, a.gasPriceWei));
  // A zero sweep (gas price 0 on a dev chain) would be a no-op call.
  if (sweepRao > 0n) calls.push({ section: "evm", method: "withdraw", args: [a.source, sweepRao] });
  return { calls, fundRao, requiredRao, sweepRao };
}

/**
 * The batch that moves an ERC-20 balance out of the EVM address a Substrate account acts as (a refund lands
 * there), to an EVM address the caller controls. Same transport as an open: one signature, no EVM gas needed.
 */
export function buildEvmCallTransferBatch(a: {
  coldkey: Hex;
  source: Address;
  mirror: Hex;
  token: Address;
  amountRaw: bigint;
  to: Address;
  gasPriceWei: bigint;
  mirrorFreeRao: bigint;
}): EvmCallBatch {
  if (a.amountRaw <= 0n) throw new InvalidParamsError("There is nothing to move.");
  const gasLimit = ERC20_TRANSFER_GAS * GAS_LIMIT_HEADROOM;
  const { requiredRao, fundRao, sweepRao } = gasPlan({
    valueWei: 0n,
    gasLimit,
    // The unmultiplied ceiling: far above a real `transfer` (~55k gas) and half the limit.
    assumedGas: ERC20_TRANSFER_GAS,
    gasPriceWei: a.gasPriceWei,
    mirrorFreeRao: a.mirrorFreeRao,
  });
  const calls: SubstrateCall[] = [];
  if (fundRao > 0n) calls.push({ section: "balances", method: "transferKeepAlive", args: [a.mirror, fundRao] });
  calls.push(
    evmCall(a.source, a.token, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a.to, a.amountRaw] }), 0n, gasLimit, a.gasPriceWei),
  );
  if (sweepRao > 0n) calls.push({ section: "evm", method: "withdraw", args: [a.source, sweepRao] });
  return { calls, fundRao, requiredRao, sweepRao };
}

interface EvmLog {
  address?: string;
  topics?: readonly (string | null)[];
}

/**
 * The order id of the intent a batch opened, read from its events. `evm.call` produces no Ethereum transaction
 * and so no receipt: the `evm.Log` events of the batch are the only place the contract's `Open` log appears.
 *
 * @throws `EvmCallFailedError` if any `evm.call` of the batch failed inside the EVM, or no `Open` log is found.
 */
export function readOpenedOrder(events: readonly SubstrateEvent[], settler: Address, extrinsicHash: Hex): Hex {
  // An `evm.call` whose EVM execution reverted still dispatches successfully (see `buildEvmCallBatch`).
  const failed = events.find((e) => e.section === "evm" && e.method === "ExecutedFailed");
  if (failed) {
    throw new EvmCallFailedError(
      "The Intents contract rejected the order while it ran inside the batch (the EVM call reverted). Nothing was opened.",
      extrinsicHash,
      failed.data,
    );
  }
  for (const e of events) {
    if (e.section !== "evm" || e.method !== "Log") continue;
    const log = e.data[0] as EvmLog | undefined;
    if (log?.address?.toLowerCase() === settler.toLowerCase() && log.topics?.[0]?.toLowerCase() === OPEN_TOPIC.toLowerCase() && log.topics[1]) {
      return log.topics[1] as Hex;
    }
  }
  throw new EvmCallFailedError("The batch was included but no `Open` event from the Intents contract was found in it.", extrinsicHash);
}
