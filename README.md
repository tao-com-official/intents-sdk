# @tao.com/intents-sdk

TypeScript SDK for [TAO.com Intents](https://docs.tao.com/intents/).

```bash
npm install @tao.com/intents-sdk viem
```

`viem` is a peer dependency (v2). The SDK is ESM + CJS, has no Node-only dependencies, and works with any
EIP-1193 wallet (`window.ethereum`, WalletConnect, Coinbase, wagmi/RainbowKit connectors) or a viem `WalletClient`.

## Quick start

```ts
import { TaoIntents } from "@tao.com/intents-sdk";

const intents = new TaoIntents({
  rpcUrls: { 1: "https://YOUR-ETHEREUM-RPC" }, // recommended for production
});

// 100 USDC on Ethereum in, native TAO on Subtensor EVM out.
const { order, quote } = await intents.execute({
  wallet: window.ethereum,
  originChainId: 1,
  destinationChainId: 964,
  outputToken: "TAO",
  amount: "100",
  onProgress: (e) => console.log(e.step), // drive your UI
});

console.log(`Sending 100 USDC, receiving ${quote.outputAmountFormatted} TAO`);

const result = await order.waitForSettlement(); // 'filled' | 'refunded'
console.log(result.state);
```

`execute` does everything in the right order:

1. connects the wallet, switches (or adds) the chain, and checks the USDC balance;
2. requests a **first quote before any approval**, so a failed quote (rate limit, no liquidity, bad route) never costs
   the user an approval transaction;
3. approves exactly the input amount if needed, then **reuses that quote**: an approval mines in seconds and a quote
   lasts ~60s. Only if less than ~20s of it is left does it take a fresh one. With enough allowance there is just
   one quote and no approval;
4. simulates `open`, sends it, and reads the order ID from the receipt of the transaction that was actually mined.

If the quote expires while the user is in the wallet prompt it requests a new one automatically.

**If something fails after the approval** (for example a re-quote is rate limited), the approval can't be undone, but
it isn't wasted: the allowance stays. The thrown error has `approvalTxHash` set so your UI can say "approved, try
again", and calling `execute` again skips the approval.

```ts
try { await intents.execute({ ... }); }
catch (e) { if (isTaoIntentsError(e) && e.approvalTxHash) showRetry("USDC approved, please try again"); }
```

### Controlling the output

The order delivers exactly the quoted amount (asking for more risks never being filled), so you control the
output by *refusing* quotes that are too low. Nothing is signed when a limit is violated; you get
`OutputBelowMinimumError` (`quoted`, `minimum`).

```ts
await intents.execute({
  ...,
  minOutputAmount: 300_000_000_000_000_000n, // never deliver less than 0.3 TAO (base units)
  slippageBps: 50,                           // a re-quote may be at most 0.5% worse than the one the user saw (default 100)
});
```

### Attribution (ERC-8021)

Pass a single code and the SDK appends an [ERC-8021](https://eip.tools/eip/8021) (schema 0) suffix to the `open`
transaction's calldata, so the order can be attributed to your app. Works on `execute` and `open`.

```ts
await intents.execute({ ..., partnerId: "my-app" });
```

The code must be printable ASCII with no spaces or commas (max 100 chars), otherwise `InvalidParamsError`
is thrown before anything is signed. `buildAttributionSuffix(code)` is exported if you need the raw suffix.

### Cancelling

Pass an `AbortSignal` to `execute`, `open`, `ensureApproval` or `getQuote`. The SDK stops waiting at any step.
It can't close a wallet prompt that is already showing or withdraw a transaction that was already sent: if you
abort after sending, `AbortedError.txHash` is set and `intents.getOrderByTransaction(chainId, txHash)` recovers the order.

### Fill deadline

`fillDeadline` must be 60 seconds to 1 day ahead (`fillWindowSeconds` defaults to 300 and is validated the same way).
Unless you pin `fillDeadline` yourself, `open` moves it to a fresh window right before the wallet signs (as the TAO
frontend does), so lingering on the review screen doesn't leave the order with little time. If you do pin it, `open`
refuses to send an order with under 60s left.

## Showing a quote first

For a "review your swap" screen, split the flow. Request the quote when the user is about to confirm, not on every
keystroke (the Quoter is rate limited), and reuse it until `validUntil`.

```ts
const quote = await intents.getQuote({
  originChainId: 1,
  destinationChainId: 964,
  outputToken: "TAO",       // symbol or address
  amount: "100",            // human units; or amountRaw: 100_000_000n
  user: account,            // required to open the intent from this quote
  recipient: otherAddress,  // optional, defaults to `user`
});

quote.outputAmountFormatted; // "0.3172..."
quote.validUntil;            // unix seconds, ~60s ahead
quote.inputUsd;              // "99.991607"  (informational)
quote.outputUsd;             // "98.036613"
quote.fees;                  // typed breakdown: totalUsd, effectiveRateBps, serviceUsd, solverUsd, fillGasUsd, ...
intents.isQuoteExpired(quote, 15); // reserve 15s for the user to sign

// Optional: approve ahead of time so the quote window isn't spent on an approval.
await intents.ensureApproval({ wallet, originChainId: 1, amount: "100" });

const { order } = await intents.open({ quote, wallet });
```

Quotes requested without `user` are indicative only; `open` rejects them with `IndicativeQuoteError`.

## Tracking orders

`Order` is returned by `execute` / `open`. Fills usually land within a few minutes. If nobody fills before
`fillDeadline`, the protocol refunds the input on the origin chain (users can't trigger this).

```ts
order.orderId;
order.explorerUrl;

const status = await order.getStatus();
// state: 'open' | 'awaiting-refund' | 'filled' | 'refunded'

const stop = order.watch((s) => render(s.state));       // fires on every state change
const final = await order.waitForSettlement({ signal, timeoutMs: 15 * 60_000 });
```

Persist `order.toJSON()` (plain JSON) so tracking survives a page reload:

```ts
localStorage.setItem("order", JSON.stringify(order));
const order = intents.getOrder(JSON.parse(localStorage.getItem("order")!));
// or, if you only stored the hash:
const order = await intents.getOrderByTransaction(1, txHash);
```

## Supported routes

Mainnet, per the docs. Input is always USDC on the origin chain; the recipient is an EVM address.

| Chain (id) | Input | Output tokens |
| --- | --- | --- |
| Ethereum (1) | `USDC` | `USDC`, `ETH` |
| Subtensor EVM (964) | `USDC` (on-chain `USDC.e`) | `USDC`, `wTAO`, `TAO` |

Tokens can be given by symbol or address. `intents.getChains()` / `intents.getTokens(chainId)` return the built-in
lists for pickers. Unlisted output addresses are passed through to the Quoter, which decides whether the route
exists (there is no `outputAmountFormatted` for them, since decimals are unknown).

## Errors

Every failure is a `TaoIntentsError` with a stable `code`; nothing is opened on-chain after a failed quote.

| Class | `code` | Typical handling |
| --- | --- | --- |
| `InvalidParamsError` | `INVALID_PARAMS` | Fix the input (bad address, amount, deadline). |
| `UnsupportedRouteError` | `UNSUPPORTED_ROUTE` | Unknown chain/token, same-chain, non-USDC input. |
| `QuoterError` | `QUOTER_ERROR` | Has `status`, `apiError`, `failures`, `retryable`, `paused`. |
| `QuoterError` | `QUOTER_FORBIDDEN` | HTTP 403: your origin/network is blocked. Not retryable; `blocked` is `true`. |
| `QuoterError` | `QUOTER_UNREACHABLE` | No response at all. In a browser this is either being offline or a CORS / allow-list block (indistinguishable), so the message says both. `blocked` is `true`. |
| `QuoteExpiredError` | `QUOTE_EXPIRED` | Request a new quote. |
| `IndicativeQuoteError` | `INDICATIVE_QUOTE` | Re-quote with `user`. |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Has `required` / `available`. |
| `InsufficientGasError` | `INSUFFICIENT_GAS` | User needs native token for gas. |
| `UserRejectedError` | `USER_REJECTED` | User dismissed the wallet prompt. |
| `ContractRevertError` | `CONTRACT_REVERT` | Has `errorName` (e.g. `FullSettler__ProtocolFeeExceedsMax`) and a readable message. |
| `TransactionRevertedError` | `TRANSACTION_REVERTED` | Mined but reverted; has `txHash`. |
| `WalletError` | `WALLET_ERROR` | Wallet/network problem. |
| `OrderNotFoundError` | `ORDER_NOT_FOUND` | Wrong chain, or hash isn't an intent. |
| `OutputBelowMinimumError` | `OUTPUT_BELOW_MINIMUM` | Your `minOutputAmount` / `slippageBps` guard. Nothing was sent. |
| `TransactionReplacedError` | `TRANSACTION_REPLACED` | The user cancelled or replaced the transaction in the wallet; no intent was opened. |
| `AbortedError` / `TimeoutError` | `ABORTED` / `TIMEOUT` | Your `signal` / `timeoutMs`. `AbortedError.txHash` is set if a tx was already sent. |

```ts
try {
  await intents.execute({ ... });
} catch (e) {
  if (e instanceof QuoterError && e.paused) showMaintenance();
  else if (e instanceof UserRejectedError) return;
  else showToast(e instanceof Error ? e.message : String(e)); // messages are user-presentable
}
```

## Configuration

```ts
new TaoIntents({
  rpcUrls: { 1: "...", 964: "..." },   // read RPCs. Set Ethereum's for production.
  publicClients: { 1: wagmiPublicClient }, // or reuse your own viem clients
  quoterUrl: "https://www.tao.com/api/v1/intents/quotes",
  quoterTimeoutMs: 15_000,
  quoterRetries: 1,                    // transient failures only; rate limits are never auto-retried
  fillWindowSeconds: 300,              // default fill window (60s to 1 day)
  chains: { 1: { intents: "0x...", rpcUrl: "http://127.0.0.1:8545" } }, // e.g. an anvil fork
});
```

## License

MIT
