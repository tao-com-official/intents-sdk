import type { Hash, Hex, PublicClient } from "viem";
import { intentsAbi, ORDER_STATUS_REFUNDED, ZERO_HASH } from "./abi";
import type { ChainConfig } from "./config";
import { AbortedError, OrderNotFoundError, TimeoutError } from "./errors";

/**
 * - `open`: waiting for a solver to fill it.
 * - `awaiting-refund`: the fill deadline passed unfilled; the protocol will refund the user (it can't be triggered manually).
 * - `filled`: the output was delivered to the recipient. Final.
 * - `refunded`: the input was returned to the user on the origin chain. Final.
 */
export type OrderState = "open" | "awaiting-refund" | "filled" | "refunded";

export interface OrderStatus {
  orderId: Hex;
  state: OrderState;
  /** True for `filled` and `refunded`. */
  isFinal: boolean;
  fillDeadline: number;
}

/** Plain-JSON reference to an order. Persist it (e.g. localStorage) to keep tracking after a reload. */
export interface OrderRef {
  orderId: Hex;
  originChainId: number;
  destinationChainId: number;
  fillDeadline: number;
  openTxHash?: Hash;
}

export interface OrderContext {
  getPublicClient(chainId: number): PublicClient;
  getChainConfig(chainId: number): ChainConfig;
  /** Current unix time in seconds. Injectable for tests. */
  now(): number;
}

export interface WatchOptions {
  /** Default 5000ms. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Called for transient polling failures (RPC hiccups). Polling continues. */
  onError?: (error: unknown) => void;
}

export interface WaitOptions extends WatchOptions {
  /** Reject with `TimeoutError` after this long. Default: wait until the order is filled or refunded. */
  timeoutMs?: number;
}

export class Order {
  readonly orderId: Hex;
  readonly originChainId: number;
  readonly destinationChainId: number;
  readonly fillDeadline: number;
  readonly openTxHash: Hash | undefined;
  readonly #ctx: OrderContext;

  constructor(ref: OrderRef, ctx: OrderContext) {
    this.orderId = ref.orderId;
    this.originChainId = ref.originChainId;
    this.destinationChainId = ref.destinationChainId;
    this.fillDeadline = ref.fillDeadline;
    this.openTxHash = ref.openTxHash;
    this.#ctx = ctx;
  }

  toJSON(): OrderRef {
    return {
      orderId: this.orderId,
      originChainId: this.originChainId,
      destinationChainId: this.destinationChainId,
      fillDeadline: this.fillDeadline,
      openTxHash: this.openTxHash,
    };
  }

  /** Block-explorer URL of the opening transaction, if known. */
  get explorerUrl(): string | undefined {
    const base = this.#ctx.getChainConfig(this.originChainId).explorerUrl;
    return this.openTxHash && base ? `${base}/tx/${this.openTxHash}` : undefined;
  }

  /** One-shot status check (two RPC reads). */
  async getStatus(): Promise<OrderStatus> {
    const origin = this.#ctx.getChainConfig(this.originChainId);
    const destination = this.#ctx.getChainConfig(this.destinationChainId);

    const [fillRecord, originStatus] = await Promise.all([
      this.#ctx.getPublicClient(this.destinationChainId).readContract({
        address: destination.intents,
        abi: intentsAbi,
        functionName: "fillRecords",
        args: [this.orderId],
      }),
      this.#ctx.getPublicClient(this.originChainId).readContract({
        address: origin.intents,
        abi: intentsAbi,
        functionName: "orderStatus",
        args: [this.orderId],
      }),
    ]);

    return { orderId: this.orderId, fillDeadline: this.fillDeadline, ...this.#resolveState(fillRecord, originStatus) };
  }

  #resolveState(fillRecord: Hex, originStatus: number): { state: OrderState; isFinal: boolean } {
    if (fillRecord !== ZERO_HASH) return { state: "filled", isFinal: true };
    if (originStatus === ORDER_STATUS_REFUNDED) return { state: "refunded", isFinal: true };
    if (originStatus === 0) {
      throw new OrderNotFoundError(
        `Order ${this.orderId} is not known to the Intents contract on chain ${this.originChainId}.`,
      );
    }
    return {
      state: this.#ctx.now() < this.fillDeadline ? "open" : "awaiting-refund",
      isFinal: false,
    };
  }

  /**
   * Poll the order and call `onUpdate` whenever its state changes (and once initially).
   * Stops on its own once the order is final. Returns an unsubscribe function.
   */
  watch(onUpdate: (status: OrderStatus) => void, options: WatchOptions = {}): () => void {
    const interval = options.pollIntervalMs ?? 5_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: OrderState | undefined;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    options.signal?.addEventListener("abort", stop, { once: true });

    const tick = async () => {
      if (stopped) return;
      try {
        const status = await this.getStatus();
        if (stopped) return;
        if (status.state !== last) {
          last = status.state;
          onUpdate(status);
        }
        if (status.isFinal) return stop();
      } catch (error) {
        options.onError?.(error);
      }
      if (!stopped) timer = setTimeout(tick, interval);
    };
    if (options.signal?.aborted) stopped = true;
    else void tick();

    return stop;
  }

  /**
   * Resolve once the order is `filled` or `refunded`.
   * Fills usually land within a few minutes; a refund follows the fill deadline.
   * Pass `signal`/`timeoutMs` to bound the wait.
   */
  waitForSettlement(options: WaitOptions = {}): Promise<OrderStatus> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        unwatch();
        cleanup();
        reject(new AbortedError());
      };
      const unwatch = this.watch(
        (status) => {
          if (status.isFinal) {
            cleanup();
            resolve(status);
          }
        },
        { pollIntervalMs: options.pollIntervalMs, onError: options.onError, signal: controller.signal },
      );
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          unwatch();
          cleanup();
          reject(new TimeoutError(`Order ${this.orderId} was not settled within ${options.timeoutMs}ms.`));
        }, options.timeoutMs);
      }
    });
  }
}
