import { decodeAbiParameters, encodeAbiParameters, zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { KNOWN_SETTLERS, TaoIntents, TYPEHASH_16AE, TYPEHASH_9737, type TaoIntentsOptions } from "../src";
import { inputOrderDataParams, inputOrderData9737Params } from "../src/abi";
import { ETH_INTENTS, jsonResponse, mockPublicClient, mockWalletClient, NOW, openLog, quoterBody, USER } from "./helpers";

/** Ethereum's `TYPEHASH_9737` settler, the built-in default. */
const NEW_SETTLER: Address = ETH_INTENTS;
/** Ethereum's `TYPEHASH_16AE` settler, the one being migrated away from. */
const OLD_SETTLER: Address = "0x2831Ea5524f171735aF8FEB2e331821bef176C8A";
/** Subtensor EVM's `TYPEHASH_16AE` settler. */
const OLD_SETTLER_964: Address = "0x24834012973b6e70997a23C7aAB01481d46CB8E1";
const REFUND_TO: Address = "0x4444444444444444444444444444444444444444";
const QUOTE = { originChainId: 1, destinationChainId: 964, outputToken: "TAO", amount: "100", user: USER } as const;

/** The Quoter's answer to the SDK's settler lookup: an indicative quote naming the settler as `approvalSpender`. */
function spender(address: Address | undefined, status = 200) {
  return () => jsonResponse(status === 200 ? { ...quoterBody(), approvalSpender: address } : { message: "bad request" }, status);
}

function setup(opts: {
  lookup?: (body: { originChainId: string }) => Response | Promise<Response>;
  /** `approvalSpender` on the user's own quote. */
  quoted?: Address;
  settler?: Address;
  chains?: TaoIntentsOptions["chains"];
  now?: () => number;
} = {}) {
  const origin = mockPublicClient({
    allowance: 10n ** 12n,
    logs: [openLog({ fillDeadline: NOW + 300, destinationChainId: 964, address: opts.settler ?? NEW_SETTLER })],
  });
  const dest = mockPublicClient();
  const lookup = vi.fn(opts.lookup ?? spender(NEW_SETTLER));
  // The lookup is the only quote asked for without a user.
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return body.userAddress === undefined ? lookup(body) : jsonResponse({ ...quoterBody(), approvalSpender: opts.quoted });
  });
  const sdk = new TaoIntents({
    fetch: fetchMock as never,
    publicClients: { 1: origin.client as never, 964: dest.client as never },
    chains: opts.chains,
    now: opts.now ?? (() => NOW),
  });
  return { sdk, origin, dest, lookup };
}

function sentOrder(wallet: ReturnType<typeof mockWalletClient>) {
  const call = wallet.writeContract.mock.calls.map(([a]) => a as { functionName: string; address: Address; args: [{ orderData: `0x${string}` }] }).find((a) => a.functionName === "open")!;
  return { address: call.address, orderData: call.args[0].orderData };
}

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
    const { sdk } = setup({ lookup: spender(OLD_SETTLER), settler: OLD_SETTLER });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    const sent = sentOrder(wallet);
    expect(sent.address).toBe(OLD_SETTLER);
    // The exact 13-field encoding, with no refund address appended.
    expect(encodeAbiParameters(inputOrderDataParams, decodeAbiParameters(inputOrderDataParams, sent.orderData))).toBe(sent.orderData);

    await expect(sdk.getQuote({ ...QUOTE, refundTo: REFUND_TO })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    await expect(sdk.getQuote({ ...QUOTE, refundTo: USER })).resolves.toBeDefined();
  });

  it("falls back to the built-in settler, in its refundTo format, when the lookup fails", async () => {
    const { sdk } = setup({ lookup: spender(undefined, 400), settler: ETH_INTENTS });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    const sent = sentOrder(wallet);
    expect(sent.address).toBe(ETH_INTENTS);
    expect(decodeAbiParameters(inputOrderData9737Params, sent.orderData)[0].refundTo).toBe(USER);
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
    const { sdk, lookup } = setup({ chains: { 1: { intents: OLD_SETTLER } }, settler: OLD_SETTLER });
    const wallet = mockWalletClient();
    await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
    expect(lookup).not.toHaveBeenCalled();
    expect(sentOrder(wallet).address).toBe(OLD_SETTLER);
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
    const { sdk, origin, dest, lookup } = setup({
      lookup: ({ originChainId }) => spender(originChainId === "964" ? OLD_SETTLER_964 : OLD_SETTLER)(),
    });
    const order = sdk.getOrder({ orderId: `0x${"ab".repeat(32)}`, originChainId: 1, destinationChainId: 964, fillDeadline: NOW + 300 });
    await order.getStatus();
    await order.getStatus();

    const readAt = (client: typeof origin.client, fn: string) =>
      client.readContract.mock.calls.map(([a]) => a as { functionName: string; address: Address }).find((a) => a.functionName === fn)!.address;
    expect(readAt(origin.client, "orderStatus")).toBe(OLD_SETTLER);
    expect(readAt(dest.client, "fillRecords")).toBe(OLD_SETTLER_964);
    expect(lookup).toHaveBeenCalledTimes(2); // one per chain, not per status check
  });

  it("asks again after a failed lookup only once the retry delay has passed", async () => {
    let now = NOW;
    const { sdk, lookup } = setup({ lookup: spender(undefined, 400), now: () => now });
    await sdk.getQuote(QUOTE);
    await sdk.getQuote(QUOTE);
    expect(lookup).toHaveBeenCalledOnce();
    now += 9;
    await sdk.getQuote(QUOTE);
    expect(lookup).toHaveBeenCalledOnce();
    now += 1;
    await sdk.getQuote(QUOTE);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("refuses an unlisted Quoter-named settler even with `orderTypehash` set", async () => {
    const unknown: Address = "0x7777777777777777777777777777777777777777";
    const chains = { 1: { orderTypehash: TYPEHASH_9737 } } as const;
    await expect(setup({ lookup: spender(unknown), chains }).sdk.getQuote(QUOTE)).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });

    const { sdk } = setup({ lookup: spender(undefined, 400), quoted: unknown, chains });
    const quote = await sdk.getQuote(QUOTE);
    const wallet = mockWalletClient();
    await expect(sdk.open({ quote, wallet: wallet as never })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("refuses a hand-set settler whose on-chain order type isn't the configured one", async () => {
    const custom: Address = "0x5555555555555555555555555555555555555555";
    const { sdk } = setup({ chains: { 1: { intents: custom, orderTypehash: TYPEHASH_16AE } }, settler: custom });
    const wallet = mockWalletClient();
    // The mock settler reports TYPEHASH_9737.
    await expect(sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never })).rejects.toMatchObject({ code: "UNSUPPORTED_ROUTE" });
    expect(wallet.writeContract.mock.calls.some(([a]) => (a as { functionName: string }).functionName === "open")).toBe(false);
  });

  it("refuses `refundTo` set to the zero address or to the settler itself", async () => {
    const { sdk } = setup();
    await expect(sdk.getQuote({ ...QUOTE, refundTo: zeroAddress })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(sdk.getQuote({ ...QUOTE, refundTo: NEW_SETTLER })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("can't have its settler list changed", () => {
    expect(() => (KNOWN_SETTLERS[TYPEHASH_9737][1] as Address[]).push(OLD_SETTLER)).toThrow(TypeError);
    expect(Object.isFrozen(KNOWN_SETTLERS[TYPEHASH_9737])).toBe(true);
  });

  describe("the settler the quote names", () => {
    it("is where the order goes when the lookup failed", async () => {
      const { sdk } = setup({ lookup: spender(undefined, 400), quoted: OLD_SETTLER, settler: OLD_SETTLER });
      const wallet = mockWalletClient();
      const quote = await sdk.getQuote(QUOTE);
      expect(quote.settler).toBe(OLD_SETTLER);
      await sdk.open({ quote, wallet: wallet as never });
      const sent = sentOrder(wallet);
      expect(sent.address).toBe(OLD_SETTLER);
      expect(encodeAbiParameters(inputOrderDataParams, decodeAbiParameters(inputOrderDataParams, sent.orderData))).toBe(sent.orderData);
    });

    it("wins over a different lookup answer", async () => {
      const { sdk } = setup({ lookup: spender(NEW_SETTLER), quoted: OLD_SETTLER, settler: OLD_SETTLER });
      const wallet = mockWalletClient();
      await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
      expect(sentOrder(wallet).address).toBe(OLD_SETTLER);
    });

    it("is ignored for a chain whose `intents` was set by hand", async () => {
      const { sdk } = setup({ chains: { 1: { intents: NEW_SETTLER } }, quoted: OLD_SETTLER });
      const wallet = mockWalletClient();
      await sdk.open({ quote: await sdk.getQuote(QUOTE), wallet: wallet as never });
      expect(sentOrder(wallet).address).toBe(NEW_SETTLER);
    });
  });
});
