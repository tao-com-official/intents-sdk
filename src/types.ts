import type { Address, Hash, Hex, WalletClient } from "viem";
import type { TokenInfo } from "./config";
import type { QuoterRoute } from "./swap";

/**
 * How the input reaches the escrow, which decides what `open` has to do:
 * - `usdc`: pulled directly (ERC-20 approval).
 * - `native`: ETH / TAO sent as `msg.value`, swapped to USDC by the settler (no approval).
 * - `erc20`: any other token, approved to the settler and swapped to USDC.
 * - `alpha`: subnet alpha staked by the user's EVM address; the settler unstakes it (staking-precompile
 *   allowance), swaps the TAO to USDC.
 */
export type InputKind = "usdc" | "native" | "erc20" | "alpha";

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
  /**
   * Input token on the origin chain. Defaults to `"USDC"`. Besides USDC, the chain's native token (`"ETH"` /
   * `"TAO"`) and `"wTAO"` are supported. On Subtensor EVM (964) `"SN<netuid>"` (e.g. `"SN64"`; `"SN0"` is root stake)
   * pays with subnet alpha staked to the connected EVM address (pass `alphaHotkey` and `user`; `amount` is in alpha, 9 decimals).
   */
  inputToken?: TokenInput;
  /**
   * Output token. Besides the chain's tokens, `"SN<netuid>"` (e.g. `"SN64"`, `"SN0"` for root stake) delivers
   * that subnet's alpha, staked for the Substrate `recipient`. Subtensor EVM (964) only.
   */
  outputToken: TokenInput;
  /**
   * Validator hotkey (SS58 or 32-byte `0x`) of a subnet alpha leg.
   * - `"SN<netuid>"` output: the validator the alpha is staked to. Defaults to the TAO.com validator.
   * - `"SN<netuid>"` input: the hotkey the user's alpha is currently staked to. Required: the settler can
   *   only unstake from the hotkey that holds the stake.
   */
  alphaHotkey?: string;
  /** Human-readable input amount, e.g. `"100"` or `"12.5"`. */
  amount?: string;
  /** Input amount in base units of the input token (e.g. `100_000_000n` = 100 USDC). Use either `amount` or `amountRaw`. */
  amountRaw?: bigint;
  /**
   * The address that will call `open`. Required to open an intent from the quote.
   * If omitted the quote is indicative only.
   */
  user?: Address;
  /**
   * Open the intent from a Substrate account instead of an EVM wallet (Subtensor EVM origin, paying native TAO or
   * subnet alpha): an SS58 address or 32-byte `0x` AccountId32. The order's `user` is then the EVM address that
   * account acts as (`substrateEvmAddress`), so don't pass `user`; do pass `recipient`, which has no default here.
   * Open the quote with `open({ quote, substrate })`. For a subnet alpha input, an `amount` that is the whole
   * stake is trimmed by 2 rao (see `Quote.inputAmount`).
   */
  substrateAccount?: string;
  /**
   * Who receives the output on the destination chain. Defaults to `user`.
   * Either an EVM address, or, for native `"TAO"` delivered on Subtensor (964), a Substrate account:
   * an SS58 address (`"5Grw..."`) or a 32-byte `0x` AccountId32. Substrate recipients are paid by the
   * solver as a native TAO transfer to that coldkey.
   * For subnet alpha (`outputToken: "SN64"`) it is the Substrate coldkey that owns the resulting stake, and is required.
   */
  recipient?: Address | (string & {});
  /**
   * Unix time (seconds) by which the intent must be filled: between 60 seconds and 1 day from now.
   * Defaults to now + `fillWindowSeconds` (5 minutes unless configured otherwise). When you leave it
   * unset, `open` moves the deadline forward to a fresh window right before the wallet signs, so a user
   * who dawdles on the review screen doesn't end up with a nearly-expired order. Set it only if you need
   * a fixed deadline; then `open` fails instead of sending an order that has under 60s left.
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
  inputToken: TokenInfo & { decimals: number };
  outputToken: TokenInfo;
  /** How the input is paid; see `InputKind`. */
  inputKind: InputKind;
  /**
   * Input amount in base units of the input token (alpha: rao). For a Substrate account's alpha input that is
   * the whole stake, 2 rao less than asked for: the stake move needs that much headroom to clear.
   */
  inputAmount: bigint;
  inputAmountFormatted: string;
  /**
   * Amount the recipient will receive, in base units. For subnet alpha this is the minimum alpha (rao, 9 decimals)
   * the stake is guaranteed to yield; otherwise it is the order's output amount.
   */
  outputAmount: bigint;
  /**
   * The `outputAmount` written into the order. Equals `outputAmount` except for subnet alpha, where the order
   * carries the native TAO (wei) the solver stakes on the recipient's behalf.
   */
  orderOutputAmount: bigint;
  /** `undefined` when the output token's decimals are unknown (raw address not in the SDK's list). */
  outputAmountFormatted: string | undefined;
  user: Address | undefined;
  /** Set when the quote is for a Substrate account (`QuoteParams.substrateAccount`): its 32-byte AccountId. */
  substrateAccount: Hex | undefined;
  /**
   * EVM recipient. For a Substrate payout this is still the user's EVM address (what the order's
   * `recipient` field carries); the coldkey is in `substrateRecipient`.
   */
  recipient: Address | undefined;
  /** Substrate AccountId32 (32-byte hex) when the output is paid to a coldkey instead of an EVM address. */
  substrateRecipient: Hex | undefined;
  /** Subnet alpha output: the subnet and validator hotkey (32-byte hex) the stake goes to. `substrateRecipient` owns it. */
  alpha: { netuid: number; hotkey: Hex } | undefined;
  /** `TransferTao` / `AlphaStake` SubtensorData (from the Quoter, checked against the requested recipient). */
  subtensorData: Hex | undefined;
  /**
   * Alpha input only: the stake the settler unstakes. `coldkey` is the Substrate account the user's EVM
   * address maps to (where the alpha must already be staked); `subtensorData` goes into the order.
   */
  alphaInput: { netuid: number; hotkey: Hex; coldkey: Hex; amount: bigint; subtensorData: Hex } | undefined;
  /**
   * The Uniswap hop the Quoter priced for a non-USDC input. `open` sizes the order's USDC floor from it
   * and falls back to asking the pool itself when the Quoter sent none.
   */
  swapRoute: QuoterRoute | undefined;
  fillDeadline: number;
  /** True when the caller pinned `fillDeadline`. Otherwise `open` refreshes it just before signing. */
  fillDeadlineIsExplicit: boolean;
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
  | { step: "approval-required"; amount: bigint; token?: TokenInfo; kind?: "erc20" | "alpha-stake" }
  | { step: "approval-submitted"; txHash: Hash }
  | { step: "approval-confirmed"; txHash: Hash }
  | { step: "swap-quoted"; minUsdc: bigint; quotedUsdc: bigint; poolFee: number; source: "quoter" | "onchain" }
  | { step: "quoting" }
  | { step: "quoted"; quote: Quote }
  | { step: "quote-refreshing"; reason: "expired" | "approval" }
  | { step: "awaiting-signature" }
  | { step: "submitted"; txHash: Hash }
  | { step: "confirmed"; txHash: Hash; orderId: Hex }
  /** Substrate account path: the batch is signed and about to be broadcast. */
  | { step: "substrate-submitted"; extrinsicHash: Hex }
  /** Substrate account path: the batch is in a block and the intent is open. */
  | { step: "substrate-confirmed"; extrinsicHash: Hex; blockHash: Hex; orderId: Hex };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}
