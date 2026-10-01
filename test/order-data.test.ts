import { decodeAbiParameters, pad, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { inputOrderDataParams } from "../src/abi";
import { buildOrder } from "../src/order-data";
import { TYPEHASH, USER } from "./helpers";

describe("buildOrder", () => {
  it("encodes InputOrderData as one tuple with USDC-path defaults", () => {
    const order = buildOrder({
      user: USER,
      inputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      inputAmount: 100_000_000n,
      outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      outputAmount: 5n,
      destinationChainId: 964,
      recipient: USER,
      maxProtocolFeeBps: 30,
      fillDeadline: 1_800_000_300,
      orderDataType: TYPEHASH,
    });
    expect(order.fillDeadline).toBe(1_800_000_300);
    expect(order.orderDataType).toBe(TYPEHASH);

    const [d] = decodeAbiParameters(inputOrderDataParams, order.orderData);
    expect(d).toMatchObject({
      user: USER,
      inputTokenToSwapFrom: zeroAddress,
      poolFee: 0,
      inputAmountToSwapFrom: 0n,
      swapDeadline: 0,
      inputAmount: 100_000_000n,
      outputAmount: 5n,
      destinationChainId: 964n,
      recipient: pad(USER, { size: 32 }),
      maxProtocolFeeBps: 30,
      subtensorData: "0x",
    });
  });
});
