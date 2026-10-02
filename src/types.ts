import type { Address, Hash, Hex, WalletClient } from "viem";
import type { TokenInfo } from "./config";

/** Any EIP-1193 provider, e.g. `window.ethereum`, WalletConnect, Coinbase Wallet, or a wagmi connector's provider. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

/** What the SDK needs to sign: an EIP-1193 provider or a viem `WalletClient`. */
export type WalletLike = Eip1193Provider | WalletClient;

/** A token given as a symbol known to the SDK (`"USDC"`, `"TAO"`, `"wTAO"`, `"ETH"`) or a `0x` address. */
export type TokenInput = string;

export interface QuoteParams {
  originChainId: number;
  destinationChainId: number;
  /** Input token on the origin chain. Defaults to `"USDC"` (the only supported input). */
  inputToken?: TokenInput;
  outputToken: TokenInput;
  /** Human-readable input amount, e.g. `"100"` or `"12.5"`. */
  amount?: string;
  /** Input amount in base units (e.g. `100_000_000n` = 100 USDC). Use either `amount` or `amountRaw`. */
  amountRaw?: bigint;
  /**
   * The address that will call `open`. Required to open an intent from the quote.
   * If omitted the quote is indicative only.
   */
  user?: Address;
  /** Who receives the output on the destination chain. Defaults to `user`. */
  recipient?: Address;
  /**
   * Unix time (seconds) by which the intent must be filled. Must be in the future and at most 1 day away.
   * Defaults to now + `fillWindowSeconds` (5 minutes unless configured otherwise).
   */
  fillDeadline?: number;
}

/**
 * Cost breakdown from the Quoter. Informational: the Quoter documents these fields as non-contractual,
 * so every key is optional. USD values are decimal strings (e.g. `"1.963386"`); `*Bps` values are numbers.
 * Only `outputAmount` is binding; the output amount already includes all of these costs.
 */
export interface QuoterFees {
  /** USD value of the input being sold. */
  sellUsd?: string;
  /** Total cost of the transfer in USD. */
  totalUsd?: string;
  /** Total cost as basis points of the input (196 = 1.96%). */
  effectiveRateBps?: number;
  /** Total cost expressed in input-token base units (USDC, 6 decimals). */
  totalInSellToken?: string;
  /** Network fee on the origin chain, in rao and USD. */
  originNetworkFeeRao?: string;
  originNetworkFeeUsd?: string;
  /** Pool fee plus price impact of swapping into the output token. */
  poolFeeAndImpactUsd?: string;
  poolSlippageBps?: number;
  /** Difference between spot price and the quoted price. */
  spotBasisUsd?: string;
  /** TAO protocol fee. */
  serviceUsd?: string;
  /** Solver margin. */
  solverUsd?: string;
  /** Gas the solver pays to fill on the destination chain. */
  fillGasUsd?: string;
  [key: string]: unknown;
}

export interface Quote {
  originChainId: number;
  destinationChainId: number;
  inputToken: TokenInfo;
  outputToken: TokenInfo;
  /** Input amount in base units. */
  inputAmount: bigint;
  inputAmountFormatted: string;
  /** Amount the recipient will receive, in base units. Used in the order unchanged. */
  outputAmount: bigint;
  /** `undefined` when the output token's decimals are unknown (raw address not in the SDK's list). */
  outputAmountFormatted: string | undefined;
  user: Address | undefined;
  recipient: Address | undefined;
  fillDeadline: number;
  /** Unix time (seconds) until which the quote holds (~60s). */
  validUntil: number;
  /** Protocol fee (bps) read when the quote was requested. It caps the fee in the order, so a fee change forces a re-quote. */
  protocolFeeBps: number | undefined;
  /** USD value of what the user pays / receives, when the Quoter provides it. Informational. */
  inputUsd: string | undefined;
  outputUsd: string | undefined;
  /** Informational cost breakdown (see `QuoterFees`). Display it, but don't build logic on it. */
  fees: QuoterFees | undefined;
  /** The untouched Quoter API response. */
  raw: unknown;
}

/** What the user has to do, or what the SDK is doing, while `execute` / `open` runs. */
export type ProgressEvent =
  | { step: "switching-chain"; chainId: number }
  | { step: "checking-balance" }
  | { step: "approval-required"; amount: bigint }
  | { step: "approval-submitted"; txHash: Hash }
  | { step: "approval-confirmed"; txHash: Hash }
  | { step: "quoting" }
  | { step: "quoted"; quote: Quote }
  | { step: "quote-refreshing"; reason: "expired" }
  | { step: "awaiting-signature" }
  | { step: "submitted"; txHash: Hash }
  | { step: "confirmed"; txHash: Hash; orderId: Hex };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}
