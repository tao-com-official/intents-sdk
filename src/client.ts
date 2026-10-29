import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { abortable, throwIfAborted } from "./abort";
import { encodeAlphaStakeInput, readMirrorColdkey, readStake, readStakeAllowance, simulateUnstakeProceeds, STAKING_PRECOMPILE, stakingAbi } from "./alpha";
import { buildAttributionSuffix } from "./attribution";
import { intentsAbi, SUBTENSOR_OP_ALPHA_STAKE, SUBTENSOR_OP_TRANSFER_TAO, subtensorDataParams } from "./abi";
import {
  buildChains,
  DEFAULT_QUOTER_URL,
  NATIVE_TOKEN_ADDRESS,
  getChainConfig,
  resolveToken,
  toViemChain,
  type ChainConfig,
  type ChainOverrides,
  type KnownToken,
  type TokenInfo,
} from "./config";
import {
  AbortedError,
  ContractRevertError,
  EvmCallFailedError,
  IndicativeQuoteError,
  InsufficientBalanceError,
  InvalidParamsError,
  OrderNotFoundError,
  OutputBelowMinimumError,
  QuoterError,
  QuoteExpiredError,
  SubstrateError,
  SwapQuoteError,
  TaoIntentsError,
  TransactionReplacedError,
  TransactionRevertedError,
  UnsupportedRouteError,
  WalletError,
} from "./errors";
import {
  alphaSellLeavingSlack,
  buildEvmCallBatch,
  buildEvmCallStakeBatch,
  buildEvmCallTransferBatch,
  evmAddressOfAccountId,
  readOpenedOrder,
  weiToRao,
} from "./evm-call";
import { normalizeError } from "./normalize";
import { buildOrder, encodeTransferTao, type OrderSwap } from "./order-data";
import { Order, type OrderContext, type OrderRef } from "./order";
import { encodeSs58, parseSubstrateAddress } from "./substrate";
import { requestQuote, type QuoterRequest } from "./quoter";
import type { SubstrateBatchResult, SubstrateCall, SubstrateSigner } from "./substrate-signer";
import { applySlippage, resolveSwapEstimate, usdToUsdc, type SwapEstimate } from "./swap";
import type { CallOptions, InputKind, Quote, QuoteParams, TokenInput, WalletLike } from "./types";
import { connectWallet, ensureWalletChain, type ConnectedWallet } from "./wallet";

export interface TaoIntentsOptions {
  /** Override the Quoter API endpoint. */
  quoterUrl?: string;
  /** Custom `fetch` (defaults to the global one). */
  fetch?: typeof fetch;
  /** Quoter request timeout. Default 15s. */
  quoterTimeoutMs?: number;
  /** Retries for transient Quoter failures. Default 1. */
  quoterRetries?: number;
  /**
   * RPC URLs for reads, by chain id. **Set one for Ethereum in production**: the default public
   * endpoint is rate limited. Subtensor EVM defaults to the public `lite.chain.opentensor.ai`.
   */
  rpcUrls?: Record<number, string>;
  /** Per-chain overrides, e.g. to target a local fork or add known output tokens. */
  chains?: Record<number, ChainOverrides>;
  /** Bring your own viem public clients (e.g. from wagmi). They take precedence over `rpcUrls`. */
  publicClients?: Record<number, PublicClient>;
  /** Default fill window when a quote doesn't specify `fillDeadline`. Default 300s. */
  fillWindowSeconds?: number;
  /** Current unix time in seconds. For tests. */
  now?: () => number;
}

interface OpenParamsBase extends CallOptions {
  quote: Quote;
  /** Refuse to send if the quote's output is below this (base units of the output token). */
  minOutputAmount?: bigint;
  /**
   * Attribution code (e.g. your app's builder code). Appended to the `open` transaction's calldata as an
   * ERC-8021 suffix so the order can be attributed to you. Printable ASCII, no commas or spaces.
   */
  partnerId?: string;
  /**
   * Non-USDC inputs only. How far, in basis points, the swap into USDC (and, for alpha, the unstake into
   * TAO) may return less than priced when `open` runs. The order's USDC floor is the priced amount minus
   * this; if the pool moves further, the transaction reverts instead of filling at a worse rate.
   * Default 100 (1%).
   */
  swapSlippageBps?: number;
}

/** Open from an EVM wallet. */
export type OpenParams = OpenParamsBase & { wallet: WalletLike; substrate?: undefined };

/**
 * Open from a Substrate account, with one signature and no EVM wallet or gas: the quote must have been
 * requested with `substrateAccount` set to the signer's address. See `substrateEvmAddress`.
 */
export type SubstrateOpenParams = OpenParamsBase & { substrate: SubstrateSigner; wallet?: undefined };

export interface OpenResult {
  order: Order;
  orderId: Hex;
  txHash: Hash;
  /** Set when the SDK had to send an approval first. */
  approvalTxHash?: Hash;
}

interface ExecuteParamsBase extends Omit<QuoteParams, "user" | "substrateAccount">, CallOptions {
  /** How many times to re-quote if the quote expires before the order is sent. Default 2. */
  maxQuoteRetries?: number;
  /** Never send an order delivering less than this (base units of the output token). */
  minOutputAmount?: bigint;
  /** ERC-8021 attribution code for the `open` transaction. See `OpenParams.partnerId`. */
  partnerId?: string;
  /** Slippage allowed on the swap of a non-USDC input. See `OpenParams.swapSlippageBps`. */
  swapSlippageBps?: number;
  /**
   * Max the output may drop, in basis points, between the first quote (the one your UI showed) and a
   * re-quote taken after an approval or an expiry. Default 100 (1%).
   */
  slippageBps?: number;
}

export type ExecuteParams = ExecuteParamsBase & { wallet: WalletLike; substrate?: undefined };

/** `execute` from a Substrate account. `recipient` is required: the account's own EVM address has no key to spend with. */
export type SubstrateExecuteParams = ExecuteParamsBase & { substrate: SubstrateSigner; wallet?: undefined };

export interface ExecuteResult extends OpenResult {
  quote: Quote;
}

/** What opening from a Substrate account returns. There is no EVM transaction: the batch is an extrinsic. */
export interface SubstrateOpenResult {
  order: Order;
  orderId: Hex;
  /** Hash of the signed extrinsic. */
  extrinsicHash: Hex;
  /** Block that included it. */
  blockHash: Hex;
}

export interface SubstrateExecuteResult extends SubstrateOpenResult {
  quote: Quote;
}

export interface RecoverStakeParams extends CallOptions {
  substrate: SubstrateSigner;
  originChainId: number;
  netuid: number;
  /** The hotkey the stranded alpha is staked to (SS58 or 32-byte `0x`). */
  hotkey: string;
  /** Rao of alpha to move. Defaults to everything staked there. */
  amountRaw?: bigint;
}

export interface RecoverRefundParams extends CallOptions {
  substrate: SubstrateSigner;
  originChainId: number;
  /** The EVM address that receives the tokens. */
  to: Address;
  /** Token to move. Defaults to `"USDC"`, which is what an unfilled order is refunded in. */
  token?: TokenInput;
  /** Base units to move. Defaults to the whole balance. */
  amountRaw?: bigint;
}

export interface EnsureApprovalParams extends CallOptions {
  wallet: WalletLike;
  originChainId: number;
  /** Token being paid. Defaults to `"USDC"`. Native tokens need no approval. */
  inputToken?: TokenInput;
  amount?: string;
  amountRaw?: bigint;
}

/** The input token once resolved against the origin chain: which path it takes, and its decimals. */
interface ResolvedInput {
  kind: InputKind;
  token: TokenInfo & { decimals: number };
  /** Alpha inputs: the subnet. */
  netuid?: number;
}

interface SwapPlan {
  estimate: SwapEstimate;
  /** Alpha inputs: what unstaking is expected to produce (wei), and the minimum the unstake must produce. */
  expectedTaoWei?: bigint;
  minTaoWei?: bigint;
}

const DEFAULT_SWAP_SLIPPAGE_BPS = 100;

/**
 * Dispatch errors the batch's closing gas sweep raises when the EVM call inside it burned its gas limit: the
 * runtime reports them as `token.` or `balances.` depending on which trait it withdrew through.
 */
const SWEEP_FAILURES = ["token.FundsUnavailable", "balances.InsufficientBalance"];

const MAX_FILL_WINDOW_SECONDS = 86_400;
/** Re-quote after an approval if less than this much of the quote's validity is left to sign. */
const REQUOTE_MARGIN_SECONDS = 20;
/** Matches the minimum the TAO frontend uses. */
const MIN_FILL_WINDOW_SECONDS = 60;

function assertSlippageBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new InvalidParamsError(`\`${name}\` must be an integer between 0 and 10000.`);
  }
}

/**
 * Entry point of the SDK. Create one instance and reuse it.
 *
 * ```ts
 * const intents = new TaoIntents({ rpcUrls: { 1: "https://..." } });
 * const { order } = await intents.execute({
 *   wallet: window.ethereum,
 *   originChainId: 1, destinationChainId: 964,
 *   outputToken: "TAO", amount: "100",
 * });
 * const result = await order.waitForSettlement();
 * ```
 */
export class TaoIntents {
  readonly #chains: Record<number, ChainConfig>;
  readonly #quoter: { url: string; fetch: typeof fetch; timeoutMs: number; retries: number };
  readonly #clients = new Map<number, PublicClient>();
  readonly #typehashes = new Map<number, Hex>();
  readonly #decimals = new Map<string, number>();
  readonly #fillWindow: number;
  readonly #now: () => number;
  readonly #ctx: OrderContext;

  constructor(options: TaoIntentsOptions = {}) {
    this.#chains = buildChains(options.chains, options.rpcUrls);
    this.#quoter = {
      url: options.quoterUrl ?? DEFAULT_QUOTER_URL,
      fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
      timeoutMs: options.quoterTimeoutMs ?? 15_000,
      retries: options.quoterRetries ?? 1,
    };
    this.#fillWindow = options.fillWindowSeconds ?? 300;
    if (this.#fillWindow < MIN_FILL_WINDOW_SECONDS || this.#fillWindow > MAX_FILL_WINDOW_SECONDS) {
      throw new InvalidParamsError(
        `\`fillWindowSeconds\` must be between ${MIN_FILL_WINDOW_SECONDS} and ${MAX_FILL_WINDOW_SECONDS}.`,
      );
    }
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    for (const [id, client] of Object.entries(options.publicClients ?? {})) this.#clients.set(Number(id), client);
    this.#ctx = {
      getPublicClient: (chainId) => this.#publicClient(chainId),
      getChainConfig: (chainId) => getChainConfig(this.#chains, chainId),
      now: this.#now,
    };
  }

  // ------------------------------------------------------------------ discovery

  /** Chains the SDK can open intents on / deliver to. */
  getChains(): ChainConfig[] {
    return Object.values(this.#chains);
  }

  /** Tokens the SDK knows on a chain (for building token pickers). `input: true` marks payable tokens. */
  getTokens(chainId: number): Array<KnownToken & { chainId: number }> {
    return getChainConfig(this.#chains, chainId).tokens.map((t) => ({ ...t, chainId }));
  }

  // ---------------------------------------------------------------------- quote

  /**
   * Ask the Quoter how much the recipient would receive. The result can be handed to `open`.
   * Quotes expire after ~60s (`quote.validUntil`); request one when the user is about to confirm.
   */
  async getQuote(params: QuoteParams, options: Pick<CallOptions, "signal"> = {}): Promise<Quote> {
    const origin = getChainConfig(this.#chains, params.originChainId);
    const destination = getChainConfig(this.#chains, params.destinationChainId);
    if (origin.id === destination.id) {
      throw new UnsupportedRouteError("The origin and destination chains must be different.");
    }

    const input = await abortable(this.#resolveInput(origin, params.inputToken), options.signal);
    const inputToken = input.token;
    const outputToken = resolveToken(destination, params.outputToken);
    let inputAmount = parseInputAmount(params, inputToken);

    // A Substrate account opens the intent as the EVM address it acts as; nothing else can be `user`.
    let substrateAccount: Hex | undefined;
    if (params.substrateAccount !== undefined) {
      const parsed = parseSubstrateAddress(params.substrateAccount);
      if (!parsed) throw new InvalidParamsError("`substrateAccount` must be an SS58 address or a 32-byte `0x` AccountId32.");
      if (params.user !== undefined) throw new InvalidParamsError("Pass `user` or `substrateAccount`, not both.");
      if (!origin.substrateEvmCall) {
        throw new UnsupportedRouteError(`${origin.name} can't open intents from a Substrate account. Use an EVM wallet.`);
      }
      if (input.kind !== "native" && input.kind !== "alpha") {
        throw new UnsupportedRouteError(
          `A Substrate account can pay ${origin.nativeCurrency.symbol} or subnet alpha (\`"SN<netuid>"\`), not ${inputToken.symbol}.`,
        );
      }
      if (!params.recipient) {
        throw new InvalidParamsError(
          "Opening from a Substrate account needs `recipient`: the account's own EVM address has no key, so nothing could be spent from it.",
        );
      }
      if (input.kind === "native" && inputAmount % 1_000_000_000n !== 0n) {
        throw new InvalidParamsError(`${inputToken.symbol} paid from a Substrate account is limited to 9 decimal places.`);
      }
      substrateAccount = parsed.accountId;
    }

    const user = substrateAccount
      ? evmAddressOfAccountId(substrateAccount)
      : params.user
        ? parseAddress(params.user, "user")
        : undefined;
    const parsedSubstrate = params.recipient ? parseSubstrateAddress(params.recipient) : undefined;
    const substrateRecipient = parsedSubstrate?.accountId;
    const ss58Recipient = parsedSubstrate && (parsedSubstrate.ss58 ?? encodeSs58(parsedSubstrate.accountId));
    const isAlpha = outputToken.netuid !== undefined;
    const isAlphaInput = input.kind === "alpha";
    if (isAlphaInput && isAlpha) {
      throw new UnsupportedRouteError("Subnet alpha can't be both the input and the output of one intent.");
    }
    if (substrateRecipient) {
      if (!destination.substrateRecipients) {
        throw new UnsupportedRouteError(`${destination.name} can't deliver to a Substrate address. Use an EVM \`recipient\`.`);
      }
      if (!outputToken.isNative && !isAlpha) {
        throw new UnsupportedRouteError(
          "A Substrate `recipient` is only supported for native TAO (`outputToken: \"TAO\"`) and subnet alpha (`\"SN<netuid>\"`), not for " + outputToken.symbol + ".",
        );
      }
    }
    if (isAlpha && !substrateRecipient) {
      throw new InvalidParamsError(
        `Delivering ${outputToken.symbol} stakes it for a Substrate coldkey: pass an SS58 address or 32-byte \`0x\` AccountId32 as \`recipient\`.`,
      );
    }
    if (params.alphaHotkey !== undefined && !isAlpha && !isAlphaInput) {
      throw new InvalidParamsError(
        "`alphaHotkey` only applies to subnet alpha inputs or outputs (`inputToken` / `outputToken: \"SN<netuid>\"`).",
      );
    }
    let alpha: { netuid: number; hotkey: Hex; ss58: string } | undefined;
    if (isAlpha) {
      const hotkeyInput = params.alphaHotkey ?? destination.defaultAlphaHotkey;
      const parsedHotkey = hotkeyInput ? parseSubstrateAddress(hotkeyInput) : undefined;
      if (!parsedHotkey) {
        throw new InvalidParamsError("`alphaHotkey` must be an SS58 address or a 32-byte `0x` AccountId32.");
      }
      alpha = {
        netuid: outputToken.netuid!,
        hotkey: parsedHotkey.accountId,
        ss58: parsedHotkey.ss58 ?? encodeSs58(parsedHotkey.accountId),
      };
    }
    // Alpha input: the settler unstakes from the user's EVM-mapped coldkey, off the hotkey that holds the
    // stake. Neither can be guessed (a wrong hotkey reverts), so both are required.
    let alphaIn: { netuid: number; hotkey: Hex; hotkeySs58: string; coldkey: Hex; coldkeySs58: string } | undefined;
    if (isAlphaInput) {
      if (!user) {
        throw new InvalidParamsError("Paying with subnet alpha needs `user`: the stake is read from that address's Substrate account.");
      }
      const parsedHotkey = params.alphaHotkey ? parseSubstrateAddress(params.alphaHotkey) : undefined;
      if (!parsedHotkey) {
        throw new InvalidParamsError(
          "Paying with subnet alpha needs `alphaHotkey` (SS58 or 32-byte `0x`): the hotkey your alpha is staked to.",
        );
      }
      const coldkey = await abortable(readMirrorColdkey(this.#publicClient(origin.id), user), options.signal).catch(
        (cause) => {
          throw new UnsupportedRouteError(
            `Couldn't resolve the Substrate account of ${user} on ${origin.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        },
      );
      if (substrateAccount) {
        // The alpha is moved to the mirror by the batch itself: it has to be there, at the coldkey, now.
        const staked = await abortable(
          readStake(this.#publicClient(origin.id), parsedHotkey.accountId, substrateAccount, input.netuid!),
          options.signal,
        );
        inputAmount = alphaSellLeavingSlack(inputAmount, staked);
      }
      alphaIn = {
        netuid: input.netuid!,
        hotkey: parsedHotkey.accountId,
        hotkeySs58: parsedHotkey.ss58 ?? encodeSs58(parsedHotkey.accountId),
        coldkey,
        coldkeySs58: encodeSs58(coldkey),
      };
    }
    // A Substrate payout still names an EVM address in the order's `recipient`; the coldkey rides in `subtensorData`.
    // That makes the user's EVM address mandatory for alpha, which can only be requested for a signer.
    const recipient = substrateRecipient || !params.recipient ? user : parseAddress(params.recipient, "recipient");

    const now = this.#now();
    const fillDeadline = params.fillDeadline ?? now + this.#fillWindow;
    if (!Number.isInteger(fillDeadline)) {
      throw new InvalidParamsError("`fillDeadline` must be a unix timestamp in whole seconds.");
    }
    if (fillDeadline < now + MIN_FILL_WINDOW_SECONDS) {
      throw new InvalidParamsError(`\`fillDeadline\` must be at least ${MIN_FILL_WINDOW_SECONDS} seconds in the future.`);
    }
    if (fillDeadline > now + MAX_FILL_WINDOW_SECONDS) {
      throw new InvalidParamsError("`fillDeadline` can be at most 1 day in the future.");
    }

    const request: QuoterRequest = {
      originChainId: String(origin.id),
      destinationChainId: String(destination.id),
      inputTokenAddress: inputToken.address,
      outputTokenAddress: outputToken.address,
      inputAmount: inputAmount.toString(),
      userAddress: user,
      // A Substrate payout is requested through a `subtensor` leg instead of `recipient`.
      ...(substrateAccount && input.kind === "native"
        ? {
            // The Quoter prices this the same with or without it; it names the Substrate account the TAO comes from.
            subtensor: {
              side: "source" as const,
              operation: "transfer_tao" as const,
              recipientColdkey: encodeSs58(substrateAccount),
              amount: inputAmount.toString(),
            },
            recipient,
          }
        : alphaIn
        ? {
            subtensor: {
              side: "source" as const,
              operation: "alpha_stake" as const,
              netuid: alphaIn.netuid,
              delegatorHotkey: alphaIn.hotkeySs58,
              recipientColdkey: alphaIn.coldkeySs58,
              amount: inputAmount.toString(),
            },
            ...(params.recipient && { recipient }),
          }
        : alpha
        ? {
            subtensor: {
              side: "destination" as const,
              operation: "alpha_stake" as const,
              netuid: alpha.netuid,
              delegatorHotkey: alpha.ss58,
              recipientColdkey: ss58Recipient!,
            },
          }
        : substrateRecipient
          ? {
              subtensor: {
                side: "destination" as const,
                operation: "transfer_tao" as const,
                recipientColdkey: ss58Recipient!,
              },
            }
          : { recipient }),
      fillDeadline,
    };

    // The protocol fee is read alongside the quote so the order can cap it at the value the quote assumed.
    const [response, protocolFeeBps] = await abortable(
      Promise.all([
        requestQuote(request, this.#quoter, options.signal),
        this.#readProtocolFee(origin).catch(() => undefined),
      ]),
      options.signal,
    );

    const orderOutputAmount = BigInt(response.quote.preview.outputs[0]!.amount);
    const quotedData = response.quote.preview.outputs[0]!.subtensorData;
    let subtensorData: Hex | undefined;
    let outputAmount = orderOutputAmount;
    if (alpha) {
      // The order carries the TAO the solver stakes; what the recipient gets is the alpha floor in the data.
      const resolved = resolveAlphaStakeData(quotedData, alpha, substrateRecipient!);
      subtensorData = resolved.data;
      outputAmount = resolved.alphaAmount;
    } else if (substrateRecipient) {
      subtensorData = resolveTransferTaoData(quotedData, substrateRecipient, orderOutputAmount);
    }
    let alphaInput: Quote["alphaInput"];
    if (alphaIn) {
      alphaInput = {
        netuid: alphaIn.netuid,
        hotkey: alphaIn.hotkey,
        coldkey: alphaIn.coldkey,
        amount: inputAmount,
        subtensorData: resolveAlphaInputData(response.quote.preview.inputs[0]?.subtensorData, alphaIn, inputAmount),
      };
    }
    return {
      originChainId: origin.id,
      destinationChainId: destination.id,
      inputToken,
      outputToken,
      inputKind: input.kind,
      alphaInput,
      swapRoute: response.route,
      inputAmount,
      inputAmountFormatted: formatUnits(inputAmount, inputToken.decimals),
      outputAmount,
      orderOutputAmount,
      outputAmountFormatted:
        outputToken.decimals !== undefined ? formatUnits(outputAmount, outputToken.decimals) : undefined,
      user,
      substrateAccount,
      recipient,
      substrateRecipient,
      alpha: alpha && { netuid: alpha.netuid, hotkey: alpha.hotkey },
      subtensorData,
      fillDeadline,
      fillDeadlineIsExplicit: params.fillDeadline !== undefined,
      validUntil: response.quote.validUntil,
      inputUsd: response.quote.preview.inputs[0]?.userPaysUsd,
      outputUsd: response.quote.preview.outputs[0]!.userReceivesUsd,
      protocolFeeBps,
      fees: response.fees,
      raw: response,
    };
  }

  /** Whether a quote can no longer be used. `marginSeconds` reserves time for the user to sign. */
  isQuoteExpired(quote: Pick<Quote, "validUntil">, marginSeconds = 0): boolean {
    return quote.validUntil - marginSeconds <= this.#now();
  }

  // ------------------------------------------------------------- approval / open

  /**
   * Make sure the Intents contract can pull the input amount. Sends an approval for exactly that
   * amount if needed: an ERC-20 approval for USDC and other tokens, a staking-precompile approval for
   * subnet alpha, nothing for a native token. Call it ahead of time (e.g. when the user starts typing an
   * amount) so the approval doesn't eat a quote's ~60s window. `execute` handles this for you.
   */
  async ensureApproval(params: EnsureApprovalParams): Promise<{ approvalTxHash?: Hash }> {
    const { signal, onProgress } = params;
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, params.originChainId);
    const input = await abortable(this.#resolveInput(origin, params.inputToken), signal);
    const amount = parseInputAmount(params, input.token);
    const wallet = await abortable(connectWallet(params.wallet), signal);
    const { allowance, approvalNeeded } = await this.#checkOrigin({ origin, wallet, input, amount, signal, onProgress });
    if (!approvalNeeded) return {};
    return { approvalTxHash: await this.#approve({ origin, wallet, input, amount, allowance, signal, onProgress }) };
  }

  /**
   * Submit the intent for a quote: switches the wallet to the origin chain, checks the balance,
   * approves USDC if needed, simulates, sends `open`, and returns the tracked `Order`.
   *
   * - Throws `QuoteExpiredError` if the quote runs out before the transaction is sent.
   * - Unless the quote's `fillDeadline` was pinned, the deadline is refreshed right before signing.
   * - `signal` stops the SDK waiting at any step. It can't withdraw an open wallet prompt or a
   *   transaction already sent; `AbortedError.txHash` is set in the latter case.
   */
  open(params: OpenParams): Promise<OpenResult>;
  /** Open from a Substrate account: one signature, no EVM wallet. See `SubstrateOpenParams`. */
  open(params: SubstrateOpenParams): Promise<SubstrateOpenResult>;
  async open(params: OpenParams | SubstrateOpenParams): Promise<OpenResult | SubstrateOpenResult> {
    if (params.substrate) return this.#openFromSubstrate(params);
    const { quote, onProgress, signal } = params;
    throwIfAborted(signal);
    const dataSuffix = params.partnerId === undefined ? undefined : buildAttributionSuffix(params.partnerId);
    const swapSlippageBps = params.swapSlippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
    assertSlippageBps(swapSlippageBps, "swapSlippageBps");
    if (!quote.user || !quote.recipient) throw new IndicativeQuoteError();
    const origin = getChainConfig(this.#chains, quote.originChainId);
    const destination = getChainConfig(this.#chains, quote.destinationChainId);
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();
    if (params.minOutputAmount !== undefined && quote.outputAmount < params.minOutputAmount) {
      throw new OutputBelowMinimumError(quote.outputAmount, params.minOutputAmount);
    }

    const wallet = await abortable(connectWallet(params.wallet), signal);
    if (wallet.account.toLowerCase() !== quote.user.toLowerCase()) {
      throw new InvalidParamsError(
        `The quote was requested for ${quote.user} but the connected wallet is ${wallet.account}. Request a new quote for the connected account.`,
      );
    }

    const input = inputOfQuote(quote);
    const { allowance, approvalNeeded } = await this.#checkOrigin({
      origin,
      wallet,
      input,
      amount: quote.inputAmount,
      signal,
      onProgress,
    });
    // Both checks run before any approval, so a user is never charged gas to approve an order that can't go through.
    await this.#assertStake(origin, quote, signal);
    const swap = await this.#planSwap({ origin, destination, quote, slippageBps: swapSlippageBps, signal, onProgress });

    let approvalTxHash: Hash | undefined;
    if (approvalNeeded) {
      approvalTxHash = await this.#approve({ origin, wallet, input, amount: quote.inputAmount, allowance, signal, onProgress });
    }
    // An approval can eat the quote's window.
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();

    const publicClient = this.#publicClient(origin.id);
    const { order, value } = await this.#assembleOrder({ origin, destination, quote, swap, signal });

    // Simulating first turns a bad order into a readable error before the user pays gas.
    try {
      await abortable(
        publicClient.simulateContract({
          account: wallet.account,
          address: origin.intents,
          abi: intentsAbi,
          functionName: "open",
          args: [order],
          ...(value > 0n && { value }),
          ...(dataSuffix && { dataSuffix }),
        }),
        signal,
      );
    } catch (error) {
      throw normalizeError(error, "open the intent");
    }
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();

    onProgress?.({ step: "awaiting-signature" });
    let submittedHash: Hash;
    try {
      submittedHash = await abortable(
        wallet.client.writeContract({
          account: wallet.account,
          chain: toViemChain(origin),
          address: origin.intents,
          abi: intentsAbi,
          functionName: "open",
          args: [order],
          ...(value > 0n && { value }),
          ...(dataSuffix && { dataSuffix }),
        }),
        signal,
      );
    } catch (error) {
      throw normalizeError(error, "send the intent");
    }
    onProgress?.({ step: "submitted", txHash: submittedHash });

    // If the user sped the transaction up, the mined one has a different hash: trust the receipt, not what we sent.
    const receipt = await this.#confirm(publicClient, submittedHash, "open", signal);
    const txHash = receipt.transactionHash;
    const ref = this.#orderRefFromReceipt(origin, receipt.logs, txHash);
    onProgress?.({ step: "confirmed", txHash, orderId: ref.orderId });

    return { order: new Order(ref, this.#ctx), orderId: ref.orderId, txHash, approvalTxHash };
  }

  /**
   * The one-call flow: connect, switch chain, check balance, quote, approve (if needed), and open.
   *
   * The first quote is requested *before* any approval, so a failed quote (rate limit, no liquidity,
   * unsupported route...) never costs the user an approval transaction. That same quote is reused
   * after the approval is mined unless under ~20s of it is left; it is also refreshed if it expires
   * while the user is signing. A failure at that point can't be fully avoided (the approval is already
   * paid), so the thrown error carries `approvalTxHash`: the allowance persists and a retry won't
   * approve again.
   *
   * Control over the output:
   * - `minOutputAmount`: never send an order that would deliver less than this (base units).
   * - `slippageBps`: a re-quote may not be worse than the first quote by more than this (default 100 = 1%).
   *
   * Either violation throws `OutputBelowMinimumError` before anything is signed.
   */
  execute(params: ExecuteParams): Promise<ExecuteResult>;
  /**
   * `execute` from a Substrate account: quote, then one signed batch that does everything `open` needs. No
   * approval step and no EVM gas. See `SubstrateExecuteParams`.
   */
  execute(params: SubstrateExecuteParams): Promise<SubstrateExecuteResult>;
  async execute(params: ExecuteParams | SubstrateExecuteParams): Promise<ExecuteResult | SubstrateExecuteResult> {
    if (params.substrate) return this.#executeFromSubstrate(params);
    const {
      wallet: walletInput,
      maxQuoteRetries = 2,
      minOutputAmount,
      slippageBps = 100,
      partnerId,
      swapSlippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
      signal,
      onProgress,
      ...quoteParams
    } = params;
    assertSlippageBps(slippageBps, "slippageBps");
    assertSlippageBps(swapSlippageBps, "swapSlippageBps");
    if (partnerId !== undefined) buildAttributionSuffix(partnerId); // fail before any approval
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, quoteParams.originChainId);
    const destination = getChainConfig(this.#chains, quoteParams.destinationChainId);
    const input = await abortable(this.#resolveInput(origin, quoteParams.inputToken), signal);
    const amount = parseInputAmount(quoteParams, input.token);
    const wallet = await abortable(connectWallet(walletInput), signal);

    const { allowance, approvalNeeded } = await this.#checkOrigin({ origin, wallet, input, amount, signal, onProgress });

    // `open` re-verifies chain/balance silently; don't repeat those events.
    const openProgress: CallOptions["onProgress"] = (e) => {
      if (e.step !== "switching-chain" && e.step !== "checking-balance") onProgress?.(e);
    };

    let firstOutput: bigint | undefined;
    const freshQuote = async (): Promise<Quote> => {
      onProgress?.({ step: "quoting" });
      const quote = await this.getQuote({ ...quoteParams, user: wallet.account }, { signal });
      onProgress?.({ step: "quoted", quote });
      // Slippage is measured against the first quote the user was shown.
      firstOutput ??= quote.outputAmount;
      const slippageFloor = (firstOutput * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
      const minimum = max(minOutputAmount ?? 0n, slippageFloor);
      if (quote.outputAmount < minimum) throw new OutputBelowMinimumError(quote.outputAmount, minimum);
      return quote;
    };

    let quote = await freshQuote();
    // Settle everything that can fail for a reason of the order itself (no stake to unstake, a swap with no
    // liquidity) before paying for an approval. `open` prices the swap again right before it signs.
    await this.#assertStake(origin, quote, signal);
    await this.#planSwap({ origin, destination, quote, slippageBps: swapSlippageBps, signal });
    let approvalTxHash: Hash | undefined;
    if (approvalNeeded) {
      approvalTxHash = await this.#approve({ origin, wallet, input, amount, allowance, signal, onProgress });
    }

    try {
      // An approval is mined in seconds and a quote lasts ~60s, so the first quote is normally still good.
      // Re-quote only if the approval left too little of it for the user to sign.
      if (approvalTxHash && this.isQuoteExpired(quote, REQUOTE_MARGIN_SECONDS)) {
        onProgress?.({ step: "quote-refreshing", reason: "approval" });
        quote = await freshQuote();
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.open({
            quote,
            wallet: wallet.client,
            partnerId,
            swapSlippageBps,
            signal,
            onProgress: openProgress,
          });
          return { ...result, approvalTxHash, quote };
        } catch (error) {
          if (error instanceof QuoteExpiredError && attempt < maxQuoteRetries) {
            onProgress?.({ step: "quote-refreshing", reason: "expired" });
            quote = await freshQuote();
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // The user already paid for the approval: tell the caller it's done so the retry can skip it.
      if (approvalTxHash && error instanceof TaoIntentsError) error.approvalTxHash = approvalTxHash;
      throw error;
    }
  }

  /**
   * Move tokens out of the EVM address a Substrate account acts as (`substrateEvmAddress`) to an EVM address you
   * control. An order opened from a Substrate account that no solver fills is refunded there, and nothing can
   * sign for that address except through the same account: this is how the refund is brought out. One
   * signature, no EVM gas.
   */
  async recoverRefund(params: RecoverRefundParams): Promise<{ extrinsicHash: Hex; blockHash: Hex; amount: bigint }> {
    const { substrate, signal, onProgress } = params;
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, params.originChainId);
    const { coldkey, source } = this.#substrateIdentity(origin, substrate);
    const token = resolveToken(origin, params.token ?? "USDC");
    if (token.isNative || token.netuid !== undefined) {
      throw new UnsupportedRouteError("Only an ERC-20 balance (a refund is paid in USDC) can be recovered this way.");
    }
    const to = parseAddress(params.to, "to");
    const decimals = token.decimals ?? (await abortable(this.#readDecimals(origin, token.address), signal));
    const client = this.#publicClient(origin.id);
    const balance = await abortable(
      client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [source] }),
      signal,
    );
    const amount = params.amountRaw ?? balance;
    if (amount <= 0n) throw new InvalidParamsError(`${source} holds no ${token.symbol} to recover.`);
    if (amount > balance) throw new InsufficientBalanceError(amount, balance, token.symbol, decimals);

    const { mirror, gasPriceWei, mirrorFreeRao } = await this.#readEvmCallState(origin, source, signal);
    const batch = buildEvmCallTransferBatch({ coldkey, source, mirror, token: token.address, amountRaw: amount, to, gasPriceWei, mirrorFreeRao });
    await this.#assertSpendable(substrate, batch, "TAO (for gas)", signal);

    const result = await this.#signBatch(substrate, batch.calls, { signal, onProgress });
    if (result.events.some((e) => e.section === "evm" && e.method === "ExecutedFailed")) {
      throw new EvmCallFailedError("The transfer reverted inside the batch. Nothing was moved.", result.extrinsicHash);
    }
    return { extrinsicHash: result.extrinsicHash, blockHash: result.blockHash, amount };
  }

  /**
   * Move subnet alpha staked at the EVM address a Substrate account acts as back to the coldkey. After an alpha
   * `open` from a Substrate account reverts, the batch still commits and leaves the stake there
   * (`EvmCallFailedError.strandedAlpha`). One signature, no EVM gas.
   */
  async recoverStake(params: RecoverStakeParams): Promise<{ extrinsicHash: Hex; blockHash: Hex; amount: bigint }> {
    const { substrate, signal, onProgress } = params;
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, params.originChainId);
    const { coldkey, source } = this.#substrateIdentity(origin, substrate);
    const parsedHotkey = parseSubstrateAddress(params.hotkey);
    if (!parsedHotkey) throw new InvalidParamsError("`hotkey` must be an SS58 address or a 32-byte `0x` AccountId32.");
    if (!Number.isInteger(params.netuid) || params.netuid < 0) throw new InvalidParamsError("`netuid` must be a subnet number.");
    const client = this.#publicClient(origin.id);

    const { mirror, gasPriceWei, mirrorFreeRao } = await this.#readEvmCallState(origin, source, signal);
    const staked = await abortable(readStake(client, parsedHotkey.accountId, mirror, params.netuid), signal);
    const amount = params.amountRaw ?? staked;
    if (amount <= 0n) throw new InvalidParamsError(`No SN${params.netuid} alpha is staked to that hotkey at ${source}'s mirror.`);
    if (amount > staked) throw new InsufficientBalanceError(amount, staked, `SN${params.netuid} alpha (at the EVM mirror)`, 9);

    const batch = buildEvmCallStakeBatch({
      coldkey, source, mirror, hotkey: parsedHotkey.accountId, netuid: params.netuid, amountRao: amount, gasPriceWei, mirrorFreeRao,
    });
    await this.#assertSpendable(substrate, batch, "TAO (for gas)", signal);
    const result = await this.#signBatch(substrate, batch.calls, { signal, onProgress });
    if (result.events.some((e) => e.section === "evm" && e.method === "ExecutedFailed")) {
      throw new EvmCallFailedError("The stake transfer reverted inside the batch. Nothing was moved.", result.extrinsicHash);
    }
    return { extrinsicHash: result.extrinsicHash, blockHash: result.blockHash, amount };
  }

  // ------------------------------------------------------------------- tracking

  /** Re-create an `Order` from a persisted reference (`order.toJSON()`). */
  getOrder(ref: OrderRef): Order {
    getChainConfig(this.#chains, ref.originChainId);
    getChainConfig(this.#chains, ref.destinationChainId);
    return new Order(ref, this.#ctx);
  }

  /** Recover an `Order` from the hash of its opening transaction (if you only stored that). */
  async getOrderByTransaction(originChainId: number, txHash: Hash): Promise<Order> {
    const origin = getChainConfig(this.#chains, originChainId);
    const receipt = await this.#publicClient(origin.id)
      .getTransactionReceipt({ hash: txHash })
      .catch(() => {
        throw new OrderNotFoundError(`Transaction ${txHash} was not found on chain ${originChainId}.`);
      });
    return new Order(this.#orderRefFromReceipt(origin, receipt.logs, txHash), this.#ctx);
  }

  // ------------------------------------------------------------------ internals

  /** The coldkey and EVM address of a Substrate signer, on a chain that can open from one. */
  #substrateIdentity(origin: ChainConfig, substrate: SubstrateSigner): { coldkey: Hex; source: Address } {
    if (!origin.substrateEvmCall) {
      throw new UnsupportedRouteError(`${origin.name} can't open intents from a Substrate account. Use an EVM wallet.`);
    }
    const parsed = parseSubstrateAddress(substrate.address);
    if (!parsed) throw new InvalidParamsError("`substrate.address` must be an SS58 address or a 32-byte `0x` AccountId32.");
    return { coldkey: parsed.accountId, source: evmAddressOfAccountId(parsed.accountId) };
  }

  /** What sizing a batch needs from the chain: the mirror account, the gas price, and the mirror's float. */
  async #readEvmCallState(origin: ChainConfig, source: Address, signal?: AbortSignal) {
    const client = this.#publicClient(origin.id);
    const [mirror, gasPriceWei, mirrorBalanceWei] = await abortable(
      Promise.all([readMirrorColdkey(client, source), client.getGasPrice(), client.getBalance({ address: source })]),
      signal,
    );
    return { mirror, gasPriceWei, mirrorFreeRao: weiToRao(mirrorBalanceWei) };
  }

  /** Refuse before asking for a signature if the coldkey can't cover what the batch moves plus its fee. */
  async #assertSpendable(
    substrate: SubstrateSigner,
    batch: { calls: SubstrateCall[]; fundRao: bigint },
    symbol: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!substrate.spendableAfterFee) return;
    let spendable: bigint;
    try {
      spendable = await abortable(substrate.spendableAfterFee(batch.calls), signal);
    } catch (error) {
      // Best effort: a failed estimate mustn't block an order that would go through.
      if (error instanceof AbortedError) throw error;
      return;
    }
    if (spendable < batch.fundRao) throw new InsufficientBalanceError(batch.fundRao, spendable, symbol, 9);
  }

  /** Sign and send a batch, turning what can go wrong into the SDK's errors. */
  async #signBatch(
    substrate: SubstrateSigner,
    calls: SubstrateCall[],
    args: { signal?: AbortSignal; onProgress?: CallOptions["onProgress"]; beforeSubmit?: () => void },
  ): Promise<SubstrateBatchResult> {
    const { signal, onProgress, beforeSubmit } = args;
    onProgress?.({ step: "awaiting-signature" });
    try {
      return await abortable(
        substrate.signAndSendBatch(calls, {
          beforeSubmit,
          onSigned: (extrinsicHash) => onProgress?.({ step: "substrate-submitted", extrinsicHash }),
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof SubstrateError && error.dispatchError && SWEEP_FAILURES.some((p) => error.dispatchError!.startsWith(p))) {
        // The closing gas sweep is sized to fail when the EVM call inside the batch reverts, and the runtime can only
        // report that as "the account can't pay".
        throw new EvmCallFailedError(
          `The batch failed on-chain (${error.dispatchError}). That is what a reverted \`open\` looks like (the closing gas sweep can't clear); nothing was opened and the batch was rolled back. It can also mean the account's balance was too low.`,
          error.extrinsicHash,
        );
      }
      throw normalizeError(error, "send the batch");
    }
  }

  /** The order for a quote: its swap fields, fee cap and type hash, with a fill deadline fresh enough to sign. */
  async #assembleOrder(args: {
    origin: ChainConfig;
    destination: ChainConfig;
    quote: Quote;
    swap: SwapPlan | undefined;
    signal?: AbortSignal;
    /**
     * Build the order for a simulation instead: as another `user`, and (alpha inputs) with the swap leg alone, paid
     * as native TAO, since the unstake can't be simulated from an account with no stake.
     */
    as?: { user: Address; nativeProceedsWei?: bigint };
  }): Promise<{ order: ReturnType<typeof buildOrder>; value: bigint; fillDeadline: number }> {
    const { origin, destination, quote, swap, signal, as } = args;
    const maxProtocolFeeBps = quote.protocolFeeBps ?? (await abortable(this.#readProtocolFee(origin), signal));
    const orderDataType = await abortable(this.#getTypehash(origin), signal);

    // As late as possible: this is the deadline the user signs.
    const now = this.#now();
    const fillDeadline = quote.fillDeadlineIsExplicit ? quote.fillDeadline : now + this.#fillWindow;
    if (fillDeadline < now + MIN_FILL_WINDOW_SECONDS) {
      throw new InvalidParamsError(
        `The fill deadline is less than ${MIN_FILL_WINDOW_SECONDS}s away, too short for a solver to fill. Request a new quote with a later \`fillDeadline\`.`,
      );
    }
    const orderSwap =
      as?.nativeProceedsWei !== undefined
        ? { inputTokenToSwapFrom: NATIVE_TOKEN_ADDRESS, inputAmountToSwapFrom: as.nativeProceedsWei, poolFee: swap!.estimate.poolFee, swapDeadline: fillDeadline }
        : swap && buildOrderSwap(quote, swap, fillDeadline);
    const order = buildOrder({
      user: as?.user ?? quote.user!,
      inputToken: origin.usdc,
      inputAmount: swap ? swap.estimate.minUsdc : quote.inputAmount,
      swap: orderSwap,
      outputToken: quote.subtensorData ? NATIVE_TOKEN_ADDRESS : quote.outputToken.address,
      outputAmount: quote.orderOutputAmount,
      destinationChainId: destination.id,
      recipient: quote.recipient!,
      subtensorData: (as?.nativeProceedsWei === undefined && quote.alphaInput?.subtensorData) || quote.subtensorData,
      maxProtocolFeeBps,
      fillDeadline,
      orderDataType,
    });
    // A native input is the transaction's value: the settler wraps it before swapping.
    const value = as?.nativeProceedsWei ?? (quote.inputKind === "native" ? quote.inputAmount : 0n);
    return { order, value, fillDeadline };
  }

  async #openFromSubstrate(params: SubstrateOpenParams): Promise<SubstrateOpenResult> {
    const { quote, substrate, onProgress, signal } = params;
    throwIfAborted(signal);
    const dataSuffix = params.partnerId === undefined ? undefined : buildAttributionSuffix(params.partnerId);
    const swapSlippageBps = params.swapSlippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
    assertSlippageBps(swapSlippageBps, "swapSlippageBps");
    if (!quote.user || !quote.recipient) throw new IndicativeQuoteError();
    const origin = getChainConfig(this.#chains, quote.originChainId);
    const destination = getChainConfig(this.#chains, quote.destinationChainId);
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();
    if (params.minOutputAmount !== undefined && quote.outputAmount < params.minOutputAmount) {
      throw new OutputBelowMinimumError(quote.outputAmount, params.minOutputAmount);
    }

    const { coldkey, source } = this.#substrateIdentity(origin, substrate);
    if (source.toLowerCase() !== quote.user.toLowerCase()) {
      throw new InvalidParamsError(
        `The quote was requested for ${quote.user} but ${substrate.address} acts as ${source}. Request a new quote with \`substrateAccount\` set to the signer.`,
      );
    }
    if (quote.inputKind !== "native" && quote.inputKind !== "alpha") {
      throw new UnsupportedRouteError(`A Substrate account can pay ${origin.nativeCurrency.symbol} or subnet alpha, not ${quote.inputToken.symbol}.`);
    }
    const client = this.#publicClient(origin.id);
    const alpha = quote.alphaInput;

    // The checks that can fail for a reason of the order itself come first, before the user is asked for anything.
    let stakedRao = 0n;
    if (alpha) {
      stakedRao = await abortable(readStake(client, alpha.hotkey, coldkey, alpha.netuid), signal);
      if (stakedRao < alpha.amount) {
        throw new InsufficientBalanceError(alpha.amount, stakedRao, `SN${alpha.netuid} alpha (on that hotkey)`, 9);
      }
    }
    const swap = await this.#planSwap({ origin, destination, quote, slippageBps: swapSlippageBps, signal, onProgress });
    const { mirror, gasPriceWei, mirrorFreeRao } = await this.#readEvmCallState(origin, source, signal);
    const allowanceRao = alpha ? await abortable(readStakeAllowance(client, source, origin.intents, alpha.netuid), signal) : 0n;
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();

    const { order, value, fillDeadline } = await this.#assembleOrder({ origin, destination, quote, swap, signal });

    // `open` can't be simulated as the account's own EVM address: it holds nothing until the batch funds it (the public
    // node ignores a balance override), and an alpha stake only reaches the mirror inside the batch. A revert inside the
    // batch doesn't undo it, so the order is simulated from the wrapped native token's address, which holds the TAO: for
    // a native input the very same order with that address as `user`, for alpha its swap leg paid as native TAO (the
    // unstake itself can't be simulated). That catches a floor the pool can't meet, a paused contract, a bad fee cap.
    const wrapped = origin.uniswap?.wrappedNative;
    if (wrapped) {
      const sim = await this.#assembleOrder({
        origin,
        destination,
        quote,
        swap,
        signal,
        as: { user: wrapped, ...(alpha && { nativeProceedsWei: swap!.expectedTaoWei! }) },
      });
      try {
        await abortable(
          client.simulateContract({
            account: wrapped,
            address: origin.intents,
            abi: intentsAbi,
            functionName: "open",
            args: [sim.order],
            ...(sim.value > 0n && { value: sim.value }),
            ...(dataSuffix && { dataSuffix }),
          }),
          signal,
        );
      } catch (error) {
        // Only a verdict from the contract counts; a node that can't run the call says nothing about the order.
        const normalized = normalizeError(error, "open the intent");
        if (normalized instanceof ContractRevertError || normalized instanceof AbortedError) throw normalized;
      }
    }
    const batch = buildEvmCallBatch({
      coldkey,
      source,
      mirror,
      settler: origin.intents,
      openCalldata: encodeFunctionData({ abi: intentsAbi, functionName: "open", args: [order] }),
      dataSuffix,
      valueWei: value,
      gasPriceWei,
      mirrorFreeRao,
      alpha: alpha && { netuid: alpha.netuid, hotkey: alpha.hotkey, alphaRao: alpha.amount, allowanceRao, stakedRao },
    });
    await this.#assertSpendable(substrate, batch, alpha ? "TAO (for gas)" : origin.nativeCurrency.symbol, signal);
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();

    const result = await this.#signBatch(substrate, batch.calls, {
      signal,
      onProgress,
      // The wallet prompt can sit open for minutes; a nearly expired order has no solver left to fill it.
      beforeSubmit: () => {
        if (fillDeadline < this.#now() + MIN_FILL_WINDOW_SECONDS) {
          throw new InvalidParamsError(
            `Signing took too long: the fill deadline is now less than ${MIN_FILL_WINDOW_SECONDS}s away. Nothing was sent; try again.`,
          );
        }
      },
    });
    let orderId: Hex;
    try {
      orderId = readOpenedOrder(result.events, origin.intents, result.extrinsicHash);
    } catch (error) {
      if (error instanceof EvmCallFailedError && alpha) {
        // The batch committed with the stake already moved to the mirror.
        throw new EvmCallFailedError(
          `${error.message} The ${quote.inputAmountFormatted} SN${alpha.netuid} alpha was moved to the account's EVM mirror before that and is still staked there: move it back with \`recoverStake\`.`,
          error.extrinsicHash,
          error.details,
          { netuid: alpha.netuid, hotkey: alpha.hotkey },
        );
      }
      throw error;
    }
    onProgress?.({ step: "substrate-confirmed", extrinsicHash: result.extrinsicHash, blockHash: result.blockHash, orderId });

    const ref: OrderRef = { orderId, originChainId: origin.id, destinationChainId: destination.id, fillDeadline };
    return { order: new Order(ref, this.#ctx), orderId, extrinsicHash: result.extrinsicHash, blockHash: result.blockHash };
  }

  async #executeFromSubstrate(params: SubstrateExecuteParams): Promise<SubstrateExecuteResult> {
    const {
      substrate,
      maxQuoteRetries = 2,
      minOutputAmount,
      slippageBps = 100,
      partnerId,
      swapSlippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
      signal,
      onProgress,
      ...quoteParams
    } = params;
    assertSlippageBps(slippageBps, "slippageBps");
    assertSlippageBps(swapSlippageBps, "swapSlippageBps");
    if (partnerId !== undefined) buildAttributionSuffix(partnerId);
    throwIfAborted(signal);

    let firstOutput: bigint | undefined;
    const freshQuote = async (): Promise<Quote> => {
      onProgress?.({ step: "quoting" });
      const quote = await this.getQuote({ ...quoteParams, substrateAccount: substrate.address }, { signal });
      onProgress?.({ step: "quoted", quote });
      // Slippage is measured against the first quote the user was shown.
      firstOutput ??= quote.outputAmount;
      const slippageFloor = (firstOutput * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
      const minimum = max(minOutputAmount ?? 0n, slippageFloor);
      if (quote.outputAmount < minimum) throw new OutputBelowMinimumError(quote.outputAmount, minimum);
      return quote;
    };

    let quote = await freshQuote();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.open({ quote, substrate, partnerId, swapSlippageBps, signal, onProgress });
        return { ...result, quote };
      } catch (error) {
        if (error instanceof QuoteExpiredError && attempt < maxQuoteRetries) {
          onProgress?.({ step: "quote-refreshing", reason: "expired" });
          quote = await freshQuote();
          continue;
        }
        throw error;
      }
    }
  }

  #publicClient(chainId: number): PublicClient {
    let client = this.#clients.get(chainId);
    if (!client) {
      const config = getChainConfig(this.#chains, chainId);
      client = createPublicClient({
        chain: toViemChain(config),
        transport: http(config.rpcUrl, { batch: true }),
      }) as PublicClient;
      this.#clients.set(chainId, client);
    }
    return client;
  }

  #readProtocolFee(origin: ChainConfig): Promise<number> {
    return this.#publicClient(origin.id).readContract({
      address: origin.intents,
      abi: intentsAbi,
      functionName: "protocolFeeBps",
    });
  }

  async #getTypehash(origin: ChainConfig): Promise<Hex> {
    // Read from the contract rather than hardcoding: it changes when the order format does.
    const cached = this.#typehashes.get(origin.id);
    if (cached) return cached;
    const typehash = await this.#publicClient(origin.id).readContract({
      address: origin.intents,
      abi: intentsAbi,
      functionName: "ONCHAIN_ORDER_DATA_TYPEHASH",
    });
    this.#typehashes.set(origin.id, typehash);
    return typehash;
  }

  /**
   * Resolve the input token against the origin chain and decide which path it takes. Anything but USDC is
   * swapped into USDC by the settler through Uniswap V3, which the chain needs a deployment for.
   */
  async #resolveInput(origin: ChainConfig, tokenInput: TokenInput = "USDC"): Promise<ResolvedInput> {
    const info = resolveToken(origin, tokenInput);
    const kind: InputKind =
      info.netuid !== undefined
        ? "alpha"
        : info.address.toLowerCase() === origin.usdc.toLowerCase()
          ? "usdc"
          : info.isNative
            ? "native"
            : "erc20";
    if (kind !== "usdc" && !origin.uniswap) {
      throw new UnsupportedRouteError(
        `${origin.name} has no Uniswap V3 deployment configured to swap ${info.symbol} into USDC. Pay with USDC (${origin.usdc}).`,
      );
    }
    const decimals = info.decimals ?? (await this.#readDecimals(origin, info.address));
    return { kind, token: { ...info, decimals }, netuid: info.netuid };
  }

  async #readDecimals(origin: ChainConfig, token: Address): Promise<number> {
    const key = `${origin.id}:${token.toLowerCase()}`;
    const cached = this.#decimals.get(key);
    if (cached !== undefined) return cached;
    let decimals: number;
    try {
      decimals = await this.#publicClient(origin.id).readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    } catch (cause) {
      throw new InvalidParamsError(`${token} is not an ERC-20 token on ${origin.name} (couldn't read its decimals).`);
    }
    this.#decimals.set(key, decimals);
    return decimals;
  }

  /**
   * Switch the wallet to the origin chain, check the balance of whatever is being paid and what it
   * allows the settler to take. Returns the current allowance and whether an approval is needed.
   */
  async #checkOrigin(args: {
    origin: ChainConfig;
    wallet: ConnectedWallet;
    input: ResolvedInput;
    amount: bigint;
    signal?: AbortSignal;
    onProgress?: CallOptions["onProgress"];
  }): Promise<{ allowance: bigint; approvalNeeded: boolean }> {
    const { origin, wallet, input, amount, signal, onProgress } = args;
    const publicClient = this.#publicClient(origin.id);

    onProgress?.({ step: "switching-chain", chainId: origin.id });
    await abortable(ensureWalletChain(wallet.client, toViemChain(origin)), signal);

    onProgress?.({ step: "checking-balance" });
    if (input.kind === "native") {
      const balance = await abortable(publicClient.getBalance({ address: wallet.account }), signal);
      if (balance < amount) throw new InsufficientBalanceError(amount, balance, input.token.symbol, input.token.decimals);
      return { allowance: 0n, approvalNeeded: false };
    }
    if (input.kind === "alpha") {
      // The alpha itself is checked once a quote names the hotkey it sits on (`#assertStake`).
      const allowance = await abortable(readStakeAllowance(publicClient, wallet.account, origin.intents, input.netuid!), signal);
      return { allowance, approvalNeeded: allowance < amount };
    }
    const [balance, allowance] = await abortable(
      Promise.all([
        publicClient.readContract({ address: input.token.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account] }),
        publicClient.readContract({
          address: input.token.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [wallet.account, origin.intents],
        }),
      ]),
      signal,
    );
    if (balance < amount) throw new InsufficientBalanceError(amount, balance, input.token.symbol, input.token.decimals);
    return { allowance, approvalNeeded: allowance < amount };
  }

  /** Alpha input: the user's EVM-mapped Substrate account must hold the alpha on the quoted hotkey. */
  async #assertStake(origin: ChainConfig, quote: Quote, signal?: AbortSignal): Promise<void> {
    const alpha = quote.alphaInput;
    if (!alpha) return;
    const staked = await abortable(readStake(this.#publicClient(origin.id), alpha.hotkey, alpha.coldkey, alpha.netuid), signal);
    if (staked < alpha.amount) {
      throw new InsufficientBalanceError(alpha.amount, staked, `SN${alpha.netuid} alpha (on that hotkey)`, 9);
    }
  }

  /**
   * Price a non-USDC input into the USDC the order escrows. `undefined` for a USDC input. For alpha this also
   * works out the minimum TAO the unstake must produce, from the chain's own swap simulation.
   */
  async #planSwap(args: {
    origin: ChainConfig;
    destination: ChainConfig;
    quote: Quote;
    slippageBps: number;
    signal?: AbortSignal;
    onProgress?: CallOptions["onProgress"];
  }): Promise<SwapPlan | undefined> {
    const { origin, destination, quote, slippageBps, signal, onProgress } = args;
    if (quote.inputKind === "usdc") return undefined;
    const uniswap = origin.uniswap;
    if (!uniswap) {
      throw new UnsupportedRouteError(`${origin.name} has no Uniswap V3 deployment configured to swap ${quote.inputToken.symbol} into USDC.`);
    }
    const client = this.#publicClient(origin.id);

    let tokenIn: Address = quote.inputToken.address;
    let amountIn = quote.inputAmount;
    let minTaoWei: bigint | undefined;
    let expectedTaoWei: bigint | undefined;
    if (quote.inputKind === "native") {
      tokenIn = uniswap.wrappedNative;
    } else if (quote.inputKind === "alpha") {
      const alpha = quote.alphaInput!;
      try {
        expectedTaoWei = await abortable(simulateUnstakeProceeds(client, alpha.netuid, alpha.amount), signal);
      } catch (cause) {
        if (cause instanceof TaoIntentsError) throw cause;
        throw new SwapQuoteError(
          `Couldn't price unstaking SN${alpha.netuid} alpha: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
      if (expectedTaoWei === undefined || expectedTaoWei <= 0n) {
        throw new SwapQuoteError(`Unstaking ${quote.inputAmountFormatted} SN${alpha.netuid} alpha would return no TAO.`);
      }
      tokenIn = uniswap.wrappedNative;
      amountIn = expectedTaoWei;
      minTaoWei = applySlippage(expectedTaoWei, slippageBps);
    }

    // The floor can only be compared with the promised output when both are USDC (same unit).
    const outputIsUsdc = !quote.subtensorData && quote.outputToken.address.toLowerCase() === destination.usdc.toLowerCase();
    const estimate = await abortable(
      resolveSwapEstimate({
        client,
        uniswap,
        usdc: origin.usdc,
        tokenIn,
        amountIn,
        slippageBps,
        chainName: origin.name,
        route: quote.swapRoute,
        promisedUsdc: outputIsUsdc ? quote.orderOutputAmount : undefined,
        referenceUsdc: usdToUsdc(quote.inputUsd),
      }),
      signal,
    );
    onProgress?.({ step: "swap-quoted", ...estimate });
    return { estimate, minTaoWei, expectedTaoWei };
  }

  /**
   * Approve exactly `amount` (not unlimited) and wait for it to be mined: an ERC-20 approval, or for alpha
   * the staking precompile's approval of the settler on the subnet.
   */
  async #approve(args: {
    origin: ChainConfig;
    wallet: ConnectedWallet;
    input: ResolvedInput;
    amount: bigint;
    /** What is currently approved; decides whether a USDT-style reset is possible. */
    allowance: bigint;
    signal?: AbortSignal;
    onProgress?: CallOptions["onProgress"];
  }): Promise<Hash> {
    const { origin, wallet, input, amount, allowance, signal, onProgress } = args;
    const isAlpha = input.kind === "alpha";
    const publicClient = this.#publicClient(origin.id);
    const kind = isAlpha ? ("alpha-stake" as const) : ("erc20" as const);
    const subject = isAlpha ? `SN${input.netuid} alpha` : input.token.symbol;

    const send = async (value: bigint): Promise<Hash> => {
      onProgress?.({ step: "approval-required", amount: value, token: input.token, kind });
      let submitted: Hash;
      try {
        submitted = await abortable(
          isAlpha
            ? wallet.client.writeContract({
                account: wallet.account,
                chain: toViemChain(origin),
                address: STAKING_PRECOMPILE,
                abi: stakingAbi,
                functionName: "approve",
                args: [origin.intents, BigInt(input.netuid!), value],
              })
            : wallet.client.writeContract({
                account: wallet.account,
                chain: toViemChain(origin),
                address: input.token.address,
                abi: erc20Abi,
                functionName: "approve",
                args: [origin.intents, value],
              }),
          signal,
        );
      } catch (error) {
        throw normalizeError(error, `approve ${subject}`);
      }
      onProgress?.({ step: "approval-submitted", txHash: submitted });
      const receipt = await this.#confirm(publicClient, submitted, "approval", signal);
      onProgress?.({ step: "approval-confirmed", txHash: receipt.transactionHash });
      return receipt.transactionHash;
    };

    // Some tokens (USDT) revert on a non-zero -> non-zero approval. Only a token the user picked can be
    // one (USDC isn't), so only then is the extra call to find out worth it. The staking precompile's
    // approval overwrites the previous value, and so needs no reset.
    if (input.kind === "erc20" && allowance > 0n) {
      const canOverwrite = await abortable(
        publicClient
          .simulateContract({
            account: wallet.account,
            address: input.token.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [origin.intents, amount],
          })
          .then(
            () => true,
            () => false,
          ),
        signal,
      );
      if (!canOverwrite) await send(0n);
    }
    return send(amount);
  }

  /**
   * Wait for a transaction and return the receipt of the one that was actually mined. Wallets can
   * speed a transaction up (same call, new hash: fine) or cancel/replace it (no intent was opened).
   */
  async #confirm(client: PublicClient, hash: Hash, what: string, signal?: AbortSignal): Promise<TransactionReceipt> {
    let replacement: { reason: "cancelled" | "replaced" | "repriced"; hash: Hash } | undefined;
    const receipt = await abortable(
      client.waitForTransactionReceipt({
        hash,
        onReplaced: (r) => {
          replacement = { reason: r.reason, hash: r.transaction.hash };
        },
      }),
      signal,
      hash,
    );
    if (replacement && replacement.reason !== "repriced") {
      throw new TransactionReplacedError(replacement.reason, hash, receipt.transactionHash, what);
    }
    if (receipt.status === "reverted") throw new TransactionRevertedError(receipt.transactionHash, what);
    return receipt;
  }

  #orderRefFromReceipt(
    origin: ChainConfig,
    logs: Parameters<typeof parseEventLogs>[0]["logs"],
    txHash: Hash,
  ): OrderRef {
    const events = parseEventLogs({ abi: intentsAbi, eventName: "Open", logs });
    const open = events.find((e) => e.address.toLowerCase() === origin.intents.toLowerCase());
    if (!open) {
      throw new OrderNotFoundError(`No Open event from the Intents contract found in transaction ${txHash}.`);
    }
    const resolved = open.args.resolvedOrder;
    const destinationChainId = resolved?.fillInstructions[0]?.destinationChainId;
    if (!resolved || destinationChainId === undefined) {
      throw new WalletError(`The Open event in ${txHash} could not be decoded.`);
    }
    return {
      orderId: open.args.orderId as Hex,
      originChainId: origin.id,
      destinationChainId: Number(destinationChainId),
      fillDeadline: resolved.fillDeadline,
      openTxHash: txHash,
    };
  }
}

/** The resolved input of a quote, without asking the chain again. */
function inputOfQuote(quote: Quote): ResolvedInput {
  return { kind: quote.inputKind, token: quote.inputToken, netuid: quote.alphaInput?.netuid };
}

/** The order's swap fields for a non-USDC input; see `OrderSwap`. */
function buildOrderSwap(quote: Quote, swap: SwapPlan, swapDeadline: number): OrderSwap | undefined {
  const { poolFee } = swap.estimate;
  switch (quote.inputKind) {
    case "usdc":
      return undefined;
    case "native":
      return { inputTokenToSwapFrom: NATIVE_TOKEN_ADDRESS, inputAmountToSwapFrom: quote.inputAmount, poolFee, swapDeadline };
    case "erc20":
      return { inputTokenToSwapFrom: quote.inputToken.address, inputAmountToSwapFrom: quote.inputAmount, poolFee, swapDeadline };
    case "alpha":
      // The settler unstakes the alpha itself and reverts if that yields less TAO than this floor.
      return { inputTokenToSwapFrom: zeroAddress, inputAmountToSwapFrom: swap.minTaoWei!, poolFee, swapDeadline };
  }
}

/** Digits with at most one dot and at least one digit ("1", "1.5", ".5", "1."), checked without backtracking. */
function isDecimalNumber(text: string): boolean {
  const [whole = "", frac, ...extra] = text.split(".");
  if (extra.length > 0 || !/^\d*$/.test(whole) || (frac !== undefined && !/^\d*$/.test(frac))) return false;
  return whole.length + (frac?.length ?? 0) > 0;
}

function parseInputAmount(
  params: { amount?: string; amountRaw?: bigint },
  token: { symbol: string; decimals: number },
): bigint {
  const { amount, amountRaw } = params;
  if ((amount === undefined) === (amountRaw === undefined)) {
    throw new InvalidParamsError("Provide exactly one of `amount` (e.g. \"100\") or `amountRaw` (base units).");
  }
  let value: bigint;
  if (amountRaw !== undefined) {
    value = amountRaw;
  } else {
    if (!isDecimalNumber(amount!.trim())) {
      throw new InvalidParamsError(`\`amount\` "${amount}" is not a valid decimal number.`);
    }
    const [, frac = ""] = amount!.trim().split(".");
    if (frac.length > token.decimals) {
      throw new InvalidParamsError(`${token.symbol} supports at most ${token.decimals} decimal places.`);
    }
    value = parseUnits(amount!.trim(), token.decimals);
  }
  if (value <= 0n) throw new InvalidParamsError("The input amount must be greater than zero.");
  return value;
}

/**
 * The Quoter returns the `TransferTao` payload for a Substrate payout; the order carries it verbatim. Check
 * it pays the coldkey the caller asked for before the user signs, and build it locally if the Quoter omitted it.
 */
function resolveTransferTaoData(fromQuoter: string | undefined, coldkey: Hex, outputAmount: bigint): Hex {
  if (!fromQuoter || fromQuoter === "0x") return encodeTransferTao(coldkey, outputAmount);
  let matches = false;
  try {
    const [data] = decodeAbiParameters(subtensorDataParams, fromQuoter as Hex);
    matches = data.operationType === SUBTENSOR_OP_TRANSFER_TAO && data.recipientColdkey.toLowerCase() === coldkey;
  } catch {
    // undecodable: treated as a mismatch below
  }
  if (!matches) {
    throw new QuoterError({
      status: 200,
      apiError: "INVALID_RESPONSE",
      message:
        "The quote service returned Substrate payout data that doesn't match the requested recipient. Nothing was sent.",
      retryable: false,
    });
  }
  return fromQuoter as Hex;
}

/**
 * The Quoter returns the `AlphaStake` payload for a subnet alpha output, with `amount` = the minimum alpha (rao)
 * the stake must yield (the settler reverts the fill below it). Unlike `TransferTao` it can't be rebuilt locally,
 * so a missing payload is an error; one that stakes to a different subnet, validator or owner is rejected.
 */
function resolveAlphaStakeData(
  fromQuoter: string | undefined,
  alpha: { netuid: number; hotkey: Hex },
  coldkey: Hex,
): { data: Hex; alphaAmount: bigint } {
  let alphaAmount: bigint | undefined;
  try {
    if (fromQuoter && fromQuoter !== "0x") {
      const [data] = decodeAbiParameters(subtensorDataParams, fromQuoter as Hex);
      if (
        data.operationType === SUBTENSOR_OP_ALPHA_STAKE &&
        data.netuid === alpha.netuid &&
        data.delegatorHotkey.toLowerCase() === alpha.hotkey &&
        data.recipientColdkey.toLowerCase() === coldkey &&
        data.amount > 0n
      ) {
        alphaAmount = data.amount;
      }
    }
  } catch {
    // undecodable: treated as a mismatch below
  }
  if (alphaAmount === undefined) {
    throw new QuoterError({
      status: 200,
      apiError: "INVALID_RESPONSE",
      message:
        "The quote service returned alpha stake data that doesn't match the requested subnet, validator and recipient. Nothing was sent.",
      retryable: false,
    });
  }
  return { data: fromQuoter as Hex, alphaAmount };
}

/**
 * The settler unstakes exactly the stake named in the order's `subtensorData`, so what the Quoter echoes must
 * name the subnet, hotkey and amount that were asked for. Unlike a payout it carries nothing the settler
 * trusts the Quoter for (the coldkey is a fill-side field), so a missing payload is built locally.
 */
function resolveAlphaInputData(
  fromQuoter: string | undefined,
  alpha: { netuid: number; hotkey: Hex; coldkey: Hex },
  amount: bigint,
): Hex {
  if (!fromQuoter || fromQuoter === "0x") return encodeAlphaStakeInput({ ...alpha, alphaRao: amount });
  let matches = false;
  try {
    const [data] = decodeAbiParameters(subtensorDataParams, fromQuoter as Hex);
    matches =
      data.operationType === SUBTENSOR_OP_ALPHA_STAKE &&
      data.netuid === alpha.netuid &&
      data.delegatorHotkey.toLowerCase() === alpha.hotkey &&
      data.amount === amount;
  } catch {
    // undecodable: treated as a mismatch below
  }
  if (!matches) {
    throw new QuoterError({
      status: 200,
      apiError: "INVALID_RESPONSE",
      message:
        "The quote service returned alpha stake data that doesn't match the requested subnet, hotkey and amount. Nothing was sent.",
      retryable: false,
    });
  }
  return fromQuoter as Hex;
}

function parseAddress(value: string, name: string): Address {
  if (!isAddress(value, { strict: false })) throw new InvalidParamsError(`\`${name}\` is not a valid address.`);
  return getAddress(value);
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
