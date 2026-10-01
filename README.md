# @tao-com-official/intents-sdk

Browser-first TypeScript SDK for [TAO Intents](https://github.com/tao-com-official/tao-docs/tree/main/docs/intents).
It hides the Quoter API and the Intents smart contract behind a few calls: quote, approve, open, track.

```bash
npm install @tao-com-official/intents-sdk viem
```

`viem` is a peer dependency (v2). The SDK is ESM + CJS, has no Node-only dependencies, and works with any
EIP-1193 wallet (`window.ethereum`, WalletConnect, Coinbase, wagmi/RainbowKit connectors) or a viem `WalletClient`.

## Quick start

```ts
import { TaoIntents } from "@tao-com-official/intents-sdk";

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

`execute` does everything in the right order: connects the wallet, switches (or adds) the chain, checks the
USDC balance, approves exactly the input amount if needed, **then** requests the quote (approvals must be mined
first or they eat the ~60s quote window), simulates `open`, sends it, and reads the order ID from the receipt.
If the quote expires while the user is in the wallet prompt it automatically requests a fresh one.

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
| `QuoteExpiredError` | `QUOTE_EXPIRED` | Request a new quote. |
| `IndicativeQuoteError` | `INDICATIVE_QUOTE` | Re-quote with `user`. |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Has `required` / `available`. |
| `InsufficientGasError` | `INSUFFICIENT_GAS` | User needs native token for gas. |
| `UserRejectedError` | `USER_REJECTED` | User dismissed the wallet prompt. |
| `ContractRevertError` | `CONTRACT_REVERT` | Has `errorName` (e.g. `FullSettler__ProtocolFeeExceedsMax`) and a readable message. |
| `TransactionRevertedError` | `TRANSACTION_REVERTED` | Mined but reverted; has `txHash`. |
| `WalletError` | `WALLET_ERROR` | Wallet/network problem. |
| `OrderNotFoundError` | `ORDER_NOT_FOUND` | Wrong chain, or hash isn't an intent. |
| `AbortedError` / `TimeoutError` | `ABORTED` / `TIMEOUT` | Your `signal` / `timeoutMs`. |

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
  fillWindowSeconds: 300,              // default fill deadline (max 1 day)
  chains: { 1: { intents: "0x...", rpcUrl: "http://127.0.0.1:8545" } }, // e.g. an anvil fork
});
```

The docs describe how to [test against an anvil fork](https://github.com/tao-com-official/tao-docs/blob/main/docs/intents/integration-guide.md#testing-without-real-funds);
the `chains` override plus a fork `rpcUrl` is how you point the SDK at one. There is no API key anywhere.

## What the SDK handles for you

- **Order encoding**: `InputOrderData` as a single ABI tuple, zero swap fields for a USDC input, left-padded recipient,
  `subtensorData = 0x`. `ONCHAIN_ORDER_DATA_TYPEHASH` is read from the contract, never hardcoded.
- **Fee guard**: `protocolFeeBps` is read with the quote and used as `maxProtocolFeeBps`, so a fee change after quoting
  reverts (readable error) instead of silently costing more.
- **Quote hygiene**: `outputAmount` goes into the order unchanged; `inputAmount`, `fillDeadline`, `outputToken`,
  `destinationChainId` and `recipient` are the exact values sent to the Quoter.
- **Safety checks**: `user` must be the connected account; balance is checked; `open` is simulated before the user pays
  gas; `validUntil` is re-checked immediately before sending.
- **Wallet plumbing**: chain switching (with `wallet_addEthereumChain` for Subtensor EVM), exact-amount approvals.
- **Status**: `fillRecords` on the destination plus `orderStatus` on the origin. This avoids `eth_getLogs` range limits
  on public RPCs.

## Scope

Covers what the [TAO docs](https://github.com/tao-com-official/tao-docs/tree/main/docs/intents) document: USDC in,
EVM-address recipient out. Swapped inputs, Substrate coldkey delivery and subnet (Alpha) tokens are intentionally not
covered (the contract paths for them are undocumented publicly).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
