import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { abortable, throwIfAborted } from "./abort";
import { buildAttributionSuffix } from "./attribution";
import { intentsAbi } from "./abi";
import {
  buildChains,
  DEFAULT_QUOTER_URL,
  getChainConfig,
  resolveToken,
  toViemChain,
  type ChainConfig,
  type ChainOverrides,
  type KnownToken,
  type TokenInfo,
} from "./config";
import {
  IndicativeQuoteError,
  InsufficientBalanceError,
  InvalidParamsError,
  OrderNotFoundError,
  OutputBelowMinimumError,
  QuoteExpiredError,
  TaoIntentsError,
  TransactionReplacedError,
  TransactionRevertedError,
  UnsupportedRouteError,
  WalletError,
} from "./errors";
import { normalizeError } from "./normalize";
import { buildOrder } from "./order-data";
import { Order, type OrderContext, type OrderRef } from "./order";
import { requestQuote, type QuoterRequest } from "./quoter";
import type { CallOptions, Quote, QuoteParams, WalletLike } from "./types";
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

export interface OpenParams extends CallOptions {
  quote: Quote;
  wallet: WalletLike;
  /** Refuse to send if the quote's output is below this (base units of the output token). */
  minOutputAmount?: bigint;
  /**
   * Attribution code (e.g. your app's builder code). Appended to the `open` transaction's calldata as an
   * ERC-8021 suffix so the order can be attributed to you. Printable ASCII, no commas or spaces.
   */
  partnerId?: string;
}

export interface OpenResult {
  order: Order;
  orderId: Hex;
  txHash: Hash;
  /** Set when the SDK had to send an approval first. */
  approvalTxHash?: Hash;
}

export interface ExecuteParams extends Omit<QuoteParams, "user">, CallOptions {
  wallet: WalletLike;
  /** How many times to re-quote if the quote expires before the order is sent. Default 2. */
  maxQuoteRetries?: number;
  /** Never send an order delivering less than this (base units of the output token). */
  minOutputAmount?: bigint;
  /** ERC-8021 attribution code for the `open` transaction. See `OpenParams.partnerId`. */
  partnerId?: string;
  /**
   * Max the output may drop, in basis points, between the first quote (the one your UI showed) and a
   * re-quote taken after an approval or an expiry. Default 100 (1%).
   */
  slippageBps?: number;
}

export interface ExecuteResult extends OpenResult {
  quote: Quote;
}

export interface EnsureApprovalParams extends CallOptions {
  wallet: WalletLike;
  originChainId: number;
  amount?: string;
  amountRaw?: bigint;
}

const MAX_FILL_WINDOW_SECONDS = 86_400;
/** Re-quote after an approval if less than this much of the quote's validity is left to sign. */
const REQUOTE_MARGIN_SECONDS = 20;
/** Matches the minimum the TAO frontend uses. */
const MIN_FILL_WINDOW_SECONDS = 60;

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

    const inputToken = resolveToken(origin, params.inputToken ?? "USDC");
    if (inputToken.address.toLowerCase() !== origin.usdc.toLowerCase()) {
      throw new UnsupportedRouteError(`The input token on ${origin.name} must be USDC (${origin.usdc}).`);
    }
    const outputToken = resolveToken(destination, params.outputToken);
    const inputAmount = parseInputAmount(params, inputToken);

    const user = params.user ? parseAddress(params.user, "user") : undefined;
    const recipient = params.recipient ? parseAddress(params.recipient, "recipient") : user;

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
      recipient,
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

    const outputAmount = BigInt(response.quote.preview.outputs[0]!.amount);
    return {
      originChainId: origin.id,
      destinationChainId: destination.id,
      inputToken,
      outputToken,
      inputAmount,
      inputAmountFormatted: formatUnits(inputAmount, inputToken.decimals!),
      outputAmount,
      outputAmountFormatted:
        outputToken.decimals !== undefined ? formatUnits(outputAmount, outputToken.decimals) : undefined,
      user,
      recipient,
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
   * amount if needed. Call it ahead of time (e.g. when the user starts typing an amount) so the
   * approval doesn't eat a quote's ~60s window. `execute` handles this for you.
   */
  async ensureApproval(params: EnsureApprovalParams): Promise<{ approvalTxHash?: Hash }> {
    const { signal, onProgress } = params;
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, params.originChainId);
    const amount = parseInputAmount(params, resolveToken(origin, "USDC"));
    const wallet = await abortable(connectWallet(params.wallet), signal);
    const { allowance } = await this.#checkOrigin({ origin, wallet, amount, signal, onProgress });
    if (allowance >= amount) return {};
    return { approvalTxHash: await this.#approve({ origin, wallet, amount, signal, onProgress }) };
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
  async open(params: OpenParams): Promise<OpenResult> {
    const { quote, onProgress, signal } = params;
    throwIfAborted(signal);
    const dataSuffix = params.partnerId === undefined ? undefined : buildAttributionSuffix(params.partnerId);
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

    const { allowance } = await this.#checkOrigin({ origin, wallet, amount: quote.inputAmount, signal, onProgress });
    let approvalTxHash: Hash | undefined;
    if (allowance < quote.inputAmount) {
      approvalTxHash = await this.#approve({ origin, wallet, amount: quote.inputAmount, signal, onProgress });
    }
    // An approval can eat the quote's window.
    if (this.isQuoteExpired(quote)) throw new QuoteExpiredError();

    const publicClient = this.#publicClient(origin.id);
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
    const order = buildOrder({
      user: quote.user,
      inputToken: origin.usdc,
      inputAmount: quote.inputAmount,
      outputToken: quote.outputToken.address,
      outputAmount: quote.outputAmount,
      destinationChainId: destination.id,
      recipient: quote.recipient,
      maxProtocolFeeBps,
      fillDeadline,
      orderDataType,
    });

    // Simulating first turns a bad order into a readable error before the user pays gas.
    try {
      await abortable(
        publicClient.simulateContract({
          account: wallet.account,
          address: origin.intents,
          abi: intentsAbi,
          functionName: "open",
          args: [order],
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
  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const {
      wallet: walletInput,
      maxQuoteRetries = 2,
      minOutputAmount,
      slippageBps = 100,
      partnerId,
      signal,
      onProgress,
      ...quoteParams
    } = params;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
      throw new InvalidParamsError("`slippageBps` must be an integer between 0 and 10000.");
    }
    if (partnerId !== undefined) buildAttributionSuffix(partnerId); // fail before any approval
    throwIfAborted(signal);
    const origin = getChainConfig(this.#chains, quoteParams.originChainId);
    const amount = parseInputAmount(quoteParams, resolveToken(origin, quoteParams.inputToken ?? "USDC"));
    const wallet = await abortable(connectWallet(walletInput), signal);

    const { allowance } = await this.#checkOrigin({ origin, wallet, amount, signal, onProgress });

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
    let approvalTxHash: Hash | undefined;
    if (allowance < amount) {
      approvalTxHash = await this.#approve({ origin, wallet, amount, signal, onProgress });
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
          const result = await this.open({ quote, wallet: wallet.client, partnerId, signal, onProgress: openProgress });
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

  /** Switch the wallet to the origin chain and check the USDC balance. Returns the current allowance. */
  async #checkOrigin(args: {
    origin: ChainConfig;
    wallet: ConnectedWallet;
    amount: bigint;
    signal?: AbortSignal;
    onProgress?: CallOptions["onProgress"];
  }): Promise<{ allowance: bigint }> {
    const { origin, wallet, amount, signal, onProgress } = args;
    const publicClient = this.#publicClient(origin.id);

    onProgress?.({ step: "switching-chain", chainId: origin.id });
    await abortable(ensureWalletChain(wallet.client, toViemChain(origin)), signal);

    onProgress?.({ step: "checking-balance" });
    const [balance, allowance] = await abortable(
      Promise.all([
        publicClient.readContract({ address: origin.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet.account] }),
        publicClient.readContract({
          address: origin.usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [wallet.account, origin.intents],
        }),
      ]),
      signal,
    );
    if (balance < amount) throw new InsufficientBalanceError(amount, balance, "USDC", 6);
    return { allowance };
  }

  /** Approve exactly `amount` (not unlimited) and wait for it to be mined. */
  async #approve(args: {
    origin: ChainConfig;
    wallet: ConnectedWallet;
    amount: bigint;
    signal?: AbortSignal;
    onProgress?: CallOptions["onProgress"];
  }): Promise<Hash> {
    const { origin, wallet, amount, signal, onProgress } = args;
    onProgress?.({ step: "approval-required", amount });
    let submitted: Hash;
    try {
      submitted = await abortable(
        wallet.client.writeContract({
          account: wallet.account,
          chain: toViemChain(origin),
          address: origin.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [origin.intents, amount],
        }),
        signal,
      );
    } catch (error) {
      throw normalizeError(error, "approve USDC");
    }
    onProgress?.({ step: "approval-submitted", txHash: submitted });
    const receipt = await this.#confirm(this.#publicClient(origin.id), submitted, "approval", signal);
    onProgress?.({ step: "approval-confirmed", txHash: receipt.transactionHash });
    return receipt.transactionHash;
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

function parseInputAmount(
  params: { amount?: string; amountRaw?: bigint },
  token: TokenInfo,
): bigint {
  const { amount, amountRaw } = params;
  if ((amount === undefined) === (amountRaw === undefined)) {
    throw new InvalidParamsError("Provide exactly one of `amount` (e.g. \"100\") or `amountRaw` (base units).");
  }
  let value: bigint;
  if (amountRaw !== undefined) {
    value = amountRaw;
  } else {
    if (!/^\d*\.?\d+$|^\d+\.$/.test(amount!.trim())) {
      throw new InvalidParamsError(`\`amount\` "${amount}" is not a valid decimal number.`);
    }
    const [, frac = ""] = amount!.trim().split(".");
    if (frac.length > token.decimals!) {
      throw new InvalidParamsError(`${token.symbol} supports at most ${token.decimals} decimal places.`);
    }
    value = parseUnits(amount!.trim(), token.decimals!);
  }
  if (value <= 0n) throw new InvalidParamsError("The input amount must be greater than zero.");
  return value;
}

function parseAddress(value: string, name: string): Address {
  if (!isAddress(value, { strict: false })) throw new InvalidParamsError(`\`${name}\` is not a valid address.`);
  return getAddress(value);
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
