import { BaseError, ContractFunctionRevertedError, parseAbi, type Address, type PublicClient } from "viem";
import type { UniswapConfig } from "./config";
import { SwapQuoteError } from "./errors";

const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Uniswap V3 fee tiers the settler can be asked to swap through. */
export const FEE_TIERS = [100, 500, 3_000, 10_000] as const;
const FEE_TIER_SET = new Set<number>(FEE_TIERS);

/**
 * The floor may not fall below this share of the output the Quoter promised, when the two are comparable
 * (the output is USDC too). Loose on purpose: the gap between them is protocol fee plus fill cost. It only
 * has to catch a floor that is wrong by orders of magnitude, such as one priced off a drained pool.
 */
const MIN_FLOOR_RATIO_PERCENT = 50n;

/**
 * Longest a single fee tier may take to price. A drained pool can cost millions of gas to quote (the 0.05%
 * wTAO/USDC pool took 6s on Subtensor's public RPC, and far longer when the node was cold), and the RPC
 * client retries on top of that. One slow tier must not hold up the rest, so a tier that misses this is
 * dropped like one that reverted.
 */
const TIER_TIMEOUT_MS = 8_000;

/**
 * Gap between launching consecutive tiers. The SDK's own RPC client batches requests made in the same tick
 * into one HTTP call, and a batch answers only when its slowest member does, so a drained pool's tier would
 * hold every other tier hostage. Launching them a few ms apart sends each as its own request.
 */
const TIER_STAGGER_MS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The origin-chain Uniswap hop as the Quoter reports it (`route` on the quote response). */
export interface QuoterRoute {
  tokenIn?: string;
  tokenOut?: string;
  poolFeeTier: number;
  /** Raw USDC out (6 decimals): no slippage, before the protocol fee. */
  amountOut: string;
}

export interface SwapEstimate {
  /** Slippage-adjusted USDC the swap must return: the order's `inputAmount`. */
  minUsdc: bigint;
  /** USDC the pool is expected to return, before slippage. */
  quotedUsdc: bigint;
  /** Fee tier the order swaps through. */
  poolFee: number;
  /** Where the estimate came from: the Quoter's solver, or a QuoterV2 call from the SDK. */
  source: "quoter" | "onchain";
}

/** `quoted` minus `slippageBps`, never below 1 (a zero floor would let the swap return nothing). */
export function applySlippage(quoted: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return quoted;
  if (slippageBps >= 10_000) return 1n;
  const min = quoted - (quoted * BigInt(slippageBps)) / 10_000n;
  return min > 0n ? min : 1n;
}

/**
 * The Quoter's `route` as numbers, or `undefined` when it is missing or unusable. Both fields are signed
 * into the order (the tier as `poolFee`, the amount as the floor) and come from an unvalidated response, so
 * an unusable route is treated as an absent one rather than trusted or thrown on.
 */
export function usableRoute(route: QuoterRoute | undefined): { minOut: bigint; poolFee: number } | undefined {
  if (!route) return undefined;
  if (!FEE_TIER_SET.has(route.poolFeeTier)) return undefined;
  if (typeof route.amountOut !== "string" || !/^[1-9]\d*$/.test(route.amountOut)) return undefined;
  return { minOut: BigInt(route.amountOut), poolFee: route.poolFeeTier };
}

function isRevert(error: unknown): boolean {
  if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bSPL\b|\bLOK\b|Unexpected error|reverted/i.test(message);
}

/**
 * Prices `amountIn` of `tokenIn` into USDC on every fee tier and keeps the best output. (Taking the first
 * tier that quotes would accept a drained pool's dust quote, which signs an order that can't be filled.)
 */
export async function quoteUsdcMinOut(args: {
  client: PublicClient;
  uniswap: UniswapConfig;
  usdc: Address;
  tokenIn: Address;
  amountIn: bigint;
  slippageBps: number;
  chainName: string;
  /** Per-tier time limit. Default 8s. */
  tierTimeoutMs?: number;
}): Promise<SwapEstimate> {
  const { client, uniswap, usdc, tokenIn, amountIn, slippageBps, chainName } = args;
  const tiers = [uniswap.defaultFee, ...FEE_TIERS.filter((f) => f !== uniswap.defaultFee)];
  const results = await Promise.allSettled(
    tiers.map(async (fee, i) => {
      if (i > 0) await sleep(i * TIER_STAGGER_MS);
      const { result } = await withTimeout(
        client.simulateContract({
          address: uniswap.quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut: usdc, amountIn, fee, sqrtPriceLimitX96: 0n }],
        }),
        args.tierTimeoutMs ?? TIER_TIMEOUT_MS,
      );
      return { fee, out: result[0] };
    }),
  );

  let best: { fee: number; out: bigint } | undefined;
  const failures: unknown[] = [];
  for (const r of results) {
    if (r.status === "rejected") failures.push(r.reason);
    else if (r.value.out > 0n && (!best || r.value.out > best.out)) best = r.value;
  }
  if (!best) {
    if (failures.length === 0 || failures.some(isRevert)) {
      throw new SwapQuoteError(
        `No Uniswap V3 liquidity to swap this token into USDC on ${chainName}. Pay with USDC instead, or try a different token.`,
        failures[0],
      );
    }
    const detail = failures[0] instanceof Error ? failures[0].message : String(failures[0]);
    throw new SwapQuoteError(`Couldn't price the swap into USDC on ${chainName}: ${detail}`, failures[0]);
  }
  return {
    quotedUsdc: best.out,
    minUsdc: applySlippage(best.out, slippageBps),
    poolFee: best.fee,
    source: "onchain",
  };
}

/**
 * Sizes the USDC floor of a swap-path order: the Quoter's own route when it is usable (it priced every
 * tier), otherwise a QuoterV2 call. Throws `SwapQuoteError` when the result is too far under what the
 * Quoter promised for the output, which can only produce an order nobody fills.
 */
export async function resolveSwapEstimate(args: {
  client: PublicClient;
  uniswap: UniswapConfig;
  usdc: Address;
  /** What the settler swaps from: the wrapped native token for native and alpha inputs, else the ERC-20. */
  tokenIn: Address;
  amountIn: bigint;
  slippageBps: number;
  chainName: string;
  tierTimeoutMs?: number;
  route: QuoterRoute | undefined;
  /** The Quoter's promised output in USDC base units. Pass only when the output is USDC. */
  promisedUsdc?: bigint;
}): Promise<SwapEstimate> {
  const hop = usableRoute(args.route);
  const estimate: SwapEstimate = hop
    ? {
        quotedUsdc: hop.minOut,
        minUsdc: applySlippage(hop.minOut, args.slippageBps),
        poolFee: hop.poolFee,
        source: "quoter",
      }
    : await quoteUsdcMinOut(args);

  if (args.promisedUsdc !== undefined && estimate.minUsdc * 100n < args.promisedUsdc * MIN_FLOOR_RATIO_PERCENT) {
    throw new SwapQuoteError(
      `The swap into USDC would return ${estimate.minUsdc} base units at minimum, far under the ${args.promisedUsdc} the quote promised. Request a new quote or pay with USDC.`,
    );
  }
  return estimate;
}
