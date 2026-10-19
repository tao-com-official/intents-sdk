import { decodeAbiParameters, pad, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { inputOrderDataParams, subtensorDataParams } from "../src/abi";
import { buildOrder, encodeTransferTao } from "../src/order-data";
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

describe("buildOrder with a Substrate payout", () => {
  const COLDKEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

  it("carries the TransferTao data and keeps the EVM recipient", () => {
    const order = buildOrder({
      user: USER,
      inputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      inputAmount: 100_000_000n,
      outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      outputAmount: 777n,
      destinationChainId: 964,
      recipient: USER,
      subtensorData: encodeTransferTao(COLDKEY, 777n),
      maxProtocolFeeBps: 30,
      fillDeadline: 1_800_000_300,
      orderDataType: TYPEHASH,
    });
    const [d] = decodeAbiParameters(inputOrderDataParams, order.orderData);
    expect(d.recipient).toBe(pad(USER, { size: 32 }));
    const [sub] = decodeAbiParameters(subtensorDataParams, d.subtensorData);
    expect(sub).toEqual({
      operationType: 2,
      netuid: 0,
      delegatorHotkey: `0x${"0".repeat(64)}`,
      recipientColdkey: COLDKEY,
      amount: 777n,
    });
  });
});
