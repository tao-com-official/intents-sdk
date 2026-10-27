import { encodeAbiParameters, pad, zeroAddress, type Address, type Hex } from "viem";
import { inputOrderDataParams, SUBTENSOR_OP_TRANSFER_TAO, subtensorDataParams } from "./abi";

const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

/**
 * How a non-USDC input becomes the escrowed USDC: the settler swaps it through Uniswap V3 inside `open()`.
 * The order's `inputAmount` is then the minimum USDC that swap must return.
 */
export interface OrderSwap {
  /**
   * What the settler swaps from: the token address for an ERC-20 (pulled with `transferFrom`), the
   * native-token sentinel for native input (paid as `msg.value`), or the zero address for an alpha input
   * (the settler unstakes the alpha itself, and `subtensorData` says which).
   */
  inputTokenToSwapFrom: Address;
  /** Native / ERC-20: the amount swapped. Alpha: the minimum native TAO (wei) the unstake must produce. */
  inputAmountToSwapFrom: bigint;
  poolFee: number;
  /** Unix seconds; the swap reverts after it. */
  swapDeadline: number;
}

export interface BuildOrderInput {
  user: Address;
  /** Always the origin chain's USDC: the escrow asset. */
  inputToken: Address;
  /** USDC escrowed. For a swap input, the minimum USDC the swap must return. */
  inputAmount: bigint;
  /** Set for native, ERC-20 and alpha inputs; omit to pay USDC directly. */
  swap?: OrderSwap;
  outputToken: Address;
  outputAmount: bigint;
  destinationChainId: number;
  recipient: Address;
  maxProtocolFeeBps: number;
  fillDeadline: number;
  orderDataType: Hex;
  /**
   * ABI-encoded TaoFullSettler `SubtensorData`. Set for Substrate payouts, where `outputToken` must be the
   * native-token sentinel and the coldkey travels here rather than in `recipient`, and for alpha inputs,
   * where it names the stake to unstake. Default `"0x"`.
   */
  subtensorData?: Hex;
}

/** `TransferTao` SubtensorData: native TAO sent to a Substrate coldkey (netuid 0, no hotkey). */
export function encodeTransferTao(recipientColdkey: Hex, amount: bigint): Hex {
  return encodeAbiParameters(subtensorDataParams, [
    {
      operationType: SUBTENSOR_OP_TRANSFER_TAO,
      netuid: 0,
      delegatorHotkey: ZERO_BYTES32,
      recipientColdkey,
      amount,
    },
  ]);
}

/**
 * Build the `OnchainCrossChainOrder` to an EVM recipient or a Substrate coldkey. The input is paid in USDC
 * unless `swap` says the settler should swap it into USDC first.
 *
 * The contract reverts silently when a USDC-direct order carries a pool fee or swap deadline, so those are
 * only written when there is a swap.
 */
export function buildOrder(input: BuildOrderInput) {
  const orderData = encodeAbiParameters(inputOrderDataParams, [
    {
      user: input.user,
      inputTokenToSwapFrom: input.swap?.inputTokenToSwapFrom ?? zeroAddress, // zero selects the plain USDC path
      poolFee: input.swap?.poolFee ?? 0,
      inputAmountToSwapFrom: input.swap?.inputAmountToSwapFrom ?? 0n,
      swapDeadline: input.swap?.swapDeadline ?? 0,
      inputToken: input.inputToken,
      inputAmount: input.inputAmount,
      outputToken: input.outputToken,
      outputAmount: input.outputAmount,
      destinationChainId: BigInt(input.destinationChainId),
      recipient: pad(input.recipient, { size: 32 }), // canonical left-padded address
      maxProtocolFeeBps: input.maxProtocolFeeBps,
      subtensorData: input.subtensorData ?? "0x",
    },
  ]);
  return { fillDeadline: input.fillDeadline, orderDataType: input.orderDataType, orderData };
}
