import { describe, expect, it, vi } from "vitest";
import { buildChains } from "../src/config";
import { Order, OrderNotFoundError, type OrderStatus } from "../src";
import { mockPublicClient, NOW, ORDER_ID } from "./helpers";

function setup(origin = {}, dest = {}, now = NOW) {
  const chains = buildChains();
  const o = mockPublicClient(origin);
  const d = mockPublicClient(dest);
  const clock = { now };
  const order = new Order(
    { orderId: ORDER_ID, originChainId: 1, destinationChainId: 964, fillDeadline: NOW + 300 },
    {
      getPublicClient: (id) => (id === 1 ? o.client : d.client) as never,
      getChainConfig: (id) => chains[id]!,
      now: () => clock.now,
    },
  );
  return { order, o, d, clock };
}

describe("Order status", () => {
  it("is open before the deadline and awaiting-refund after", async () => {
    const { order, clock } = setup();
    expect((await order.getStatus()).state).toBe("open");
    clock.now = NOW + 301;
    expect(await order.getStatus()).toMatchObject({ state: "awaiting-refund", isFinal: false });
  });

  it("is filled when the destination has a fill record", async () => {
    const { order } = setup({}, { fillRecord: `0x${"01".repeat(32)}` });
    expect(await order.getStatus()).toMatchObject({ state: "filled", isFinal: true });
  });

  it("is refunded when the origin status is 3", async () => {
    const { order } = setup({ orderStatus: 3 });
    expect(await order.getStatus()).toMatchObject({ state: "refunded", isFinal: true });
  });

  it("throws OrderNotFoundError for unknown orders", async () => {
    const { order } = setup({ orderStatus: 0 });
    await expect(order.getStatus()).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it("waitForSettlement polls until filled", async () => {
    const { order, d } = setup();
    let reads = 0;
    d.client.readContract.mockImplementation(async () => (++reads >= 3 ? (`0x${"01".repeat(32)}` as never) : (`0x${"0".repeat(64)}` as never)));
    const status = await order.waitForSettlement({ pollIntervalMs: 5 });
    expect(status.state).toBe("filled");
    expect(reads).toBe(3);
  });

  it("watch reports each state change once and stops when final", async () => {
    const { order, d, clock } = setup();
    const seen: string[] = [];
    let filled = false;
    d.client.readContract.mockImplementation(async () => (filled ? (`0x${"01".repeat(32)}` as never) : (`0x${"0".repeat(64)}` as never)));
    await new Promise<void>((resolve) => {
      order.watch(
        (s: OrderStatus) => {
          seen.push(s.state);
          if (s.state === "open") clock.now = NOW + 400;
          if (s.state === "awaiting-refund") filled = true;
          if (s.isFinal) resolve();
        },
        { pollIntervalMs: 5 },
      );
    });
    expect(seen).toEqual(["open", "awaiting-refund", "filled"]);
  });

  it("waitForSettlement honours timeout and abort", async () => {
    const { order } = setup();
    await expect(order.waitForSettlement({ pollIntervalMs: 5, timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const ac = new AbortController();
    const p = order.waitForSettlement({ pollIntervalMs: 5, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("keeps polling through transient RPC errors", async () => {
    const { order, d } = setup();
    const onError = vi.fn();
    let n = 0;
    d.client.readContract.mockImplementation(async () => {
      if (++n === 1) throw new Error("rpc down");
      return `0x${"01".repeat(32)}` as never;
    });
    const status = await order.waitForSettlement({ pollIntervalMs: 5, onError });
    expect(status.state).toBe("filled");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("serializes to a plain reference", () => {
    const { order } = setup();
    expect(JSON.parse(JSON.stringify(order))).toMatchObject({ orderId: ORDER_ID, originChainId: 1, destinationChainId: 964 });
  });
});
