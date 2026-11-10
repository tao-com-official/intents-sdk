import { decodeAbiParameters, encodeAbiParameters, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_SETTLERS, TaoIntents, TYPEHASH_9737, type TaoIntentsOptions } from "../src";
import { inputOrderDataParams, inputOrderData9737Params } from "../src/abi";
import { ETH_INTENTS, jsonResponse, mockPublicClient, mockWalletClient, NOW, openLog, quoterBody, USER } from "./helpers";

const NEW_SETTLER: Address = "0x3333333333333333333333333333333333333333";
const REFUND_TO: Address = "0x4444444444444444444444444444444444444444";
const QUOTE = { originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100", user: USER } as const;

/** The Quoter's answer to the SDK's settler lookup: an indicative quote naming the settler as `approvalSpender`. */
function spender(address: Address | undefined, status = 200) {
  return () => jsonResponse(status === 200 ? { ...quoterBody(), approvalSpender: address } : { message: "bad request" }, status);
}

function setup(opts: { lookup?: (body: { originChainId: string }) => Response | Promise<Response>; settler?: Address; chains?: TaoIntentsOptions["chains"] } = {}) {
  const origin = mockPublicClient({
    allowance: 10n ** 12n,
    logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 964, address: opts.settler ?? NEW_SETTLER })],
  });
  const dest = mockPublicClient();
  const lookup = vi.fn(opts.lookup ?? spender(NEW_SETTLER));
  // The lookup is the only quote asked for without a user.
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return body.userAddress === undefined ? lookup(body) : jsonResponse(quoterBody());
  });
  const sdk = new TaoIntents({
    fetch: fetchMock as never,
    publicClients: { 1: origin.client as never, 964: dest.client as never },
    chains: opts.chains,
    now: () => NOW,
  });
  return { sdk, origin, dest, lookup };
}

function sentOrder(wallet: ReturnType<typeof mockWalletClient>) {
  const call = wallet.writeContract.mock.calls.map(([a]) => a as { functionName: string; address: Address; args: [{ orderData: `0x${string}` }] }).find((a) => a.functionName === "open")!;
  return { address: call.address, orderData: call.args[0].orderData };
}

beforeEach(() => KNOWN_SETTLERS[TYPEHASH_9737][1]!.push(NEW_SETTLER));
afterEach(() => KNOWN_SETTLERS[TYPEHASH_9737][1]!.splice(KNOWN_SETTLERS[TYPEHASH_9737][1]!.indexOf(NEW_SETTLER), 1));

describe("settler migration", () => {
  it("opens on the settler the Quoter names, refunding the user by default", async () => {
    const { sdk } = setup();
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote(QUOTE);
    await sdk.open({ quote, wallet: wallet as never });

    const sent = sentOrder(wallet);
    expect(sent.address).toBe(NEW_SETTLER);
    const [d] = decodeAbiParameters(inputOrderData9737Params, sent.orderData);
    expect(d.refundTo).toBe(USER);
  });

  it("writes `refundTo` into the order", async () => {
    const { sdk } = setup();
    const wallet = mockWalletClient();
    const quote = await sdk.getQuote({ ...QUOTE, refundTo: REFUND_TO });
    expect(quote.refundTo).toBe(REFUND_TO);
    await sdk.open({ quote, wallet: wallet as never });
    const [d] = decodeAbiParameters(inputOrderData9737Params, sentOrder(wallet).orderData);
    expect(d.refundTo).toBe(REFUND_TO);
  });

  it("keeps the old order format on a TYPEHASH_16AE settler and refuses a different `refundTo` there", async () => {
    const { sdk } = setup({ lookup: spender(ETH_INTENTS), settler: ETH_INTENTS });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    const sent = sentOrder(wallet);
    expect(sent.address).toBe(ETH_INTENTS);
    // The exact 13-field encoding, with no refund address appended.
    expect(encodeAbiParameters(inputOrderDataParams, decodeAbiParameters(inputOrderDataParams, sent.orderData))).toBe(sent.orderData);

    await expect(sdk.getQuote({ ...QUOTE, refundTo: REFUND_TO })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    await expect(sdk.getQuote({ ...QUOTE, refundTo: USER })).resolves.toBeDefined();
  });

  it("falls back to the configured settler when the lookup fails", async () => {
    const { sdk } = setup({ lookup: spender(undefined, 400), settler: ETH_INTENTS });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    expect(sentOrder(wallet).address).toBe(ETH_INTENTS);
  });

  it("refuses a settler it doesn't know", async () => {
    const { sdk } = setup({ lookup: spender(REFUND_TO) });
    await expect(sdk.getQuote(QUOTE)).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
  });

  it("looks a chain up once for several calls", async () => {
    const { sdk, lookup } = setup();
    await sdk.getQuote(QUOTE);
    await sdk.getQuote(QUOTE);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("skips the lookup for a chain whose `intents` was set by hand", async () => {
    const { sdk, lookup } = setup({ chains: { 1: { intents: NEW_SETTLER } } });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    expect(lookup).not.toHaveBeenCalled();
    expect(sentOrder(wallet).address).toBe(NEW_SETTLER);
  });

  it("encodes for a hand-set settler with `orderTypehash`", async () => {
    const custom: Address = "0x5555555555555555555555555555555555555555";
    const { sdk } = setup({ chains: { 1: { intents: custom, orderTypehash: TYPEHASH_9737 } }, settler: custom });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    const { orderData } = sentOrder(wallet);
    expect(encodeAbiParameters(inputOrderData9737Params, decodeAbiParameters(inputOrderData9737Params, orderData))).toBe(orderData);
  });

  it("tracks an order on the settlers the Quoter names for both chains", async () => {
    const DEST_SETTLER: Address = "0x6666666666666666666666666666666666666666";
    KNOWN_SETTLERS[TYPEHASH_9737][964]!.push(DEST_SETTLER);
    try {
      const { sdk, origin, dest, lookup } = setup({
        lookup: ({ originChainId }) => spender(originChainId === "964" ? DEST_SETTLER : NEW_SETTLER)(),
      });
      const order = sdk.getOrder({ orderId: `0x${"ab".repeat(32)}`, originChainId: 1, destinationChainId: 964, fillDeadline: NOW + 300 });
      await order.getStatus();
      await order.getStatus();

      const readAt = (client: typeof origin.client, fn: string) =>
        client.readContract.mock.calls.map(([a]) => a as { functionName: string; address: Address }).find((a) => a.functionName === fn)!.address;
      expect(readAt(origin.client, "orderStatus")).toBe(NEW_SETTLER);
      expect(readAt(dest.client, "fillRecords")).toBe(DEST_SETTLER);
      expect(lookup).toHaveBeenCalledTimes(2); // one per chain, not per status check
    } finally {
      KNOWN_SETTLERS[TYPEHASH_9737][964]!.splice(KNOWN_SETTLERS[TYPEHASH_9737][964]!.indexOf(DEST_SETTLER), 1);
    }
  });
});
