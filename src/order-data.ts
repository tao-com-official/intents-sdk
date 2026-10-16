import { encodeAbiParameters, pad, zeroAddress, type Address, type Hex } from "viem";
import { inputOrderDataParams, SUBTENSOR_OP_TRANSFER_TAO, subtensorDataParams } from "./abi";

const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

export interface BuildOrderInput {
  user: Address;
  inputToken: Address;
  inputAmount: bigint;
  outputToken: Address;
  outputAmount: bigint;
  destinationChainId: number;
  recipient: Address;
  maxProtocolFeeBps: number;
  fillDeadline: number;
  orderDataType: Hex;
  /**
   * ABI-encoded TaoFullSettler `SubtensorData`. Set for Substrate payouts, where `outputToken` must be the
   * native-token sentinel and the coldkey travels here rather than in `recipient`. Default `"0x"`.
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

/** Build the `OnchainCrossChainOrder` for a USDC-input transfer to an EVM recipient or a Substrate coldkey. */
export function buildOrder(input: BuildOrderInput) {
  const orderData = encodeAbiParameters(inputOrderDataParams, [
    {
      user: input.user,
      inputTokenToSwapFrom: zeroAddress, // zero selects the plain USDC path
      poolFee: 0,
      inputAmountToSwapFrom: 0n,
      swapDeadline: 0,
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
