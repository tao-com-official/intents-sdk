import { encodeAbiParameters, pad, zeroAddress, type Address, type Hex } from "viem";
import { inputOrderDataParams } from "./abi";

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
}

/** Build the `OnchainCrossChainOrder` for a USDC-input transfer to an EVM recipient. */
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
      subtensorData: "0x",
    },
  ]);
  return { fillDeadline: input.fillDeadline, orderDataType: input.orderDataType, orderData };
}
