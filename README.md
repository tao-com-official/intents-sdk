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

1. connects the wallet, switches (or adds) the chain, and checks the balance of what is being paid (USDC by default);
2. requests a **first quote before any approval**, so a failed quote (rate limit, no liquidity, bad route) never costs
   the user an approval transaction;
3. approves exactly the input amount if needed (nothing for a native token), then **reuses that quote**: an approval mines in seconds and a quote
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

Mainnet, per the docs. The recipient is an EVM address, or a Substrate account when delivering native TAO on
Subtensor (see below).

| Chain (id) | Input | Output tokens |
| --- | --- | --- |
| Ethereum (1) | `USDC`, `ETH` | `USDC`, `ETH` |
| Subtensor EVM (964) | `USDC` (on-chain `USDC.e`), `TAO`, `wTAO`, `SN<netuid>` (subnet alpha, see below) | `USDC`, `wTAO`, `TAO`, `SN<netuid>` (subnet alpha, see below) |

Tokens can be given by symbol or address. `intents.getChains()` / `intents.getTokens(chainId)` return the built-in
lists for pickers. Unlisted output addresses are passed through to the Quoter, which decides whether the route
exists (there is no `outputAmountFormatted` for them, since decimals are unknown).

## Paying with something other than USDC

`inputToken` defaults to `"USDC"`. Any other input is swapped into USDC by the settler inside `open()`, through
Uniswap V3, before the USDC is escrowed. The order's USDC amount becomes the **minimum the swap must return**, so the
swap can't fill at a worse price than you allowed.

```ts
// 0.5 ETH on Ethereum in, native TAO out
await intents.execute({ wallet, originChainId: 1, destinationChainId: 964, outputToken: "TAO",
  inputToken: "ETH", amount: "0.5", swapSlippageBps: 50 });
```

| Input | What the user signs |
| --- | --- |
| `USDC` | ERC-20 approval (if needed), then `open`. |
| Native (`ETH`, `TAO`) | Only `open`, with the amount as the transaction value. No approval. |
| `wTAO` | ERC-20 approval of that token, then `open`. |
| Subnet alpha (`SN<netuid>`) | A staking-precompile approval, then `open` (see below). |

How the USDC floor is set: the Quoter reports the Uniswap hop it priced (`quote.swapRoute`: fee tier and expected USDC).
`open` uses that, minus `swapSlippageBps` (default 100 = 1%). If the Quoter sent none, the SDK asks Uniswap's QuoterV2
itself on every fee tier and keeps the best output. A floor far below what the quote promised throws
`SwapQuoteError` rather than signing an order nobody can fill. The `swap-quoted` progress event reports the result.

Things to know:

- The supported inputs are the ones in the table above: they are the tokens the solver serves on mainnet.
- The swap is **single-hop** (a native input is swapped as WETH / wTAO against USDC). Nothing is routed through
  intermediate pools, so a pair without a direct USDC pool fails with `SwapQuoteError` ("No Uniswap V3 liquidity"),
  before any approval is paid.
- Pricing through QuoterV2 (when the Quoter sent no route) asks every fee tier and gives each a few seconds, so a
  drained pool that is slow to quote is dropped instead of stalling the rest. Public RPCs rate-limit these calls; set
  `rpcUrls` to your own node in production.
- A native input needs the amount **plus gas**. The SDK checks the balance covers the amount; gas shortfalls surface as
  `InsufficientGasError` from the simulation.
- The protocol fee is taken from the swapped USDC, and the quoted output already accounts for it.
- `quote.inputAmount` is in the input token's units; the order's USDC escrow is derived at `open` time, so a slow user
  gets a floor priced right before they sign (and the swap is priced again, not reused from `getQuote`).

### Paying with subnet alpha

On Subtensor EVM (964), `inputToken: "SN<netuid>"` (`"SN0"` is root stake) pays with alpha. The settler unstakes it for
the user (`transferStakeFrom` + `removeStake`), swaps the TAO it gets into USDC, and escrows that.

```ts
await intents.execute({
  wallet, originChainId: 964, destinationChainId: 1, outputToken: "USDC",
  inputToken: "SN64", amount: "1.5",               // alpha, 9 decimals
  alphaHotkey: "5HK5...",                          // the hotkey the alpha is staked to (required)
});
```

- The alpha must already be staked by the **EVM address that signs**, i.e. the Substrate account that address maps to
  (`HashedAddressMapping`, read from the chain's address-mapping precompile). Alpha held by a regular Substrate wallet
  has to be moved there first with a `transfer_stake` extrinsic, or skip that step by [paying from a Substrate account
  directly](#paying-from-a-substrate-account).
- `alphaHotkey` must be the hotkey that holds the stake: the settler can only unstake from it. A missing or insufficient
  stake throws `InsufficientBalanceError` before anything is approved.
- The approval is the staking precompile's `approve(settler, netuid, amount)`, for exactly the alpha amount.
- The minimum TAO the unstake must produce is computed from the chain's own `simSwapAlphaForTao` simulation (root stake is
  1:1), less `swapSlippageBps`. The settler reverts the whole `open` if the unstake yields less.
- Alpha can't be both the input and the output of one intent, and the destination can't be Subtensor EVM itself (the
  Quoter rejects same-chain quotes).

## Paying from a Substrate account

A Substrate coldkey can open an intent **with one signature and no EVM wallet or gas**, paying native TAO or subnet
alpha. The SDK builds one `utility.batchAll` that the coldkey signs; inside it the coldkey drives the EVM through
`evm.call`, acting as the EVM address made of the first 20 bytes of its public key (`substrateEvmAddress(account)`):

- native TAO: fund that address with the amount plus gas, call `open`;
- alpha: `transfer_stake` to the address's mirror account, fund gas, approve the settler on the staking precompile
  (skipped if already allowed), call `open`;
- in both, sweep the unused gas back to the coldkey. The sweep is also what makes the batch atomic for alpha: if `open`
  reverts it burns the gas the sweep needs and the whole batch (stake move included) rolls back.

The SDK has no Substrate dependency: you give it a `SubstrateSigner`. `polkadotSigner` adapts a polkadot-js `ApiPromise`
(connected over WebSocket) and an extension signer or keyring pair.

```ts
import { TaoIntents, polkadotSigner } from "@tao.com/intents-sdk";

const substrate = polkadotSigner({ api, account: address, signer: injector.signer });
const { order, extrinsicHash } = await intents.execute({
  substrate,                                     // instead of `wallet`
  originChainId: 964, destinationChainId: 1,
  inputToken: "TAO", outputToken: "USDC", amount: "1",   // or inputToken: "SN64" + alphaHotkey
  recipient: "0xYourEvmAddress",                 // required: the account's own EVM address has no key
});
```

`getQuote({ substrateAccount: address, recipient, ... })` followed by `open({ quote, substrate })` works like the EVM flow.
Any other `SubstrateSigner` only needs `signAndSendBatch(calls)` (a `utility.batchAll` of `{ section, method, args }`) and,
optionally, `spendableAfterFee(calls)` so the SDK can refuse before asking for a signature.

- **Only native TAO and alpha**, on Subtensor EVM. USDC / wTAO are paid from an EVM wallet as before; nothing about that
  path changed.
- **`recipient` is required.** The order's `user` is the account's EVM address, which has no private key.
- **Refunds land at that address.** An order nobody fills is refunded in USDC to `substrateEvmAddress(account)`.
  `recoverRefund({ substrate, originChainId: 964, to })` moves it to an address you control, with one signature. Gas left
  at that address by an earlier batch is reused by the next one.
- **Alpha: amounts that are the whole stake lose 2 rao** (`quote.inputAmount` shows it): the stake move needs that much
  headroom to clear. The alpha must sit at the coldkey, on `alphaHotkey`.
- **Native TAO amounts are limited to 9 decimals** (whole rao).
- There is no pre-flight simulation of `open` (the account's EVM address holds nothing until the batch funds it, and the
  public node ignores balance overrides). A reverted `open` is caught from the batch's events and throws
  `EvmCallFailedError`; for a native input the TAO then stays at that address, available to the next batch.
- The result has no EVM transaction: `extrinsicHash` / `blockHash` replace `txHash`, and `order.openTxHash` is unset.
  Progress events are `substrate-submitted` and `substrate-confirmed`. The extrinsic is mortal for ~51 minutes, since
  a wallet that can't decode the batch makes users read before signing; the SDK vetoes a signature that leaves the fill
  deadline under 60s.
- Fees: the batch's extrinsic fee scales with its gas limits (measured live ~0.0067 TAO native, ~0.027 TAO with an
  alpha approval) and is paid by the coldkey on top of the gas it funds.

## Delivering TAO to a Substrate wallet

Native TAO (`outputToken: "TAO"`, destination 964) can be paid straight to a Substrate coldkey. Pass an SS58 address
(checksum verified) or a 32-byte `0x` AccountId32 as `recipient`:

```ts
await intents.execute({
  wallet, originChainId: 1, destinationChainId: 964,
  outputToken: "TAO", amount: "100",
  recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
});
```

The SDK sends the Quoter a `subtensor` leg (`transfer_tao`, destination) in place of `recipient`.
The order keeps the user's EVM address as its `recipient` and carries the Quoter's `TransferTao` `subtensorData`, which
holds the coldkey; the SDK checks that data pays the coldkey you asked for before anything is signed.
`quote.substrateRecipient` holds the resolved 32-byte account. Any other token or destination throws
`UnsupportedRouteError`. Substrate payouts are priced with a higher solver margin than EVM ones.

## Delivering subnet alpha

Subnet alpha tokens are an output on Subtensor EVM (964). Use `"SN<netuid>"` as `outputToken` (`"SN64"`; `"SN0"` is root
stake) and a Substrate `recipient`, the coldkey that will own the stake:

```ts
await intents.execute({
  wallet, originChainId: 1, destinationChainId: 964,
  outputToken: "SN64", amount: "100",
  recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  alphaHotkey: "5HK5...", // optional validator to stake to; defaults to the TAO.com validator
});
```

Alpha isn't an ERC-20 the solver can transfer: the order's output token is native TAO, and the settler
(`TaoFullSettler`) stakes that TAO into the subnet for the coldkey (`addStake` + `transferStake`) when the solver fills.
The SDK sends the Quoter an `alpha_stake` destination leg and the order carries the Quoter's `AlphaStake`
`subtensorData`. Things that differ from other outputs:

- `quote.outputAmount` is the **minimum alpha** the stake must yield (rao, 9 decimals; the fill reverts below it), and
  `outputAmountFormatted` is that amount. `quote.orderOutputAmount` is the native TAO (wei) written into the order.
  `minOutputAmount` and `slippageBps` apply to the alpha amount.
- `quote.alpha` holds the subnet and validator hotkey; `quote.substrateRecipient` is the stake owner.
- The SDK checks the Quoter's data stakes to the subnet, validator and coldkey you asked for, and rejects it otherwise
  (a payload can't be rebuilt locally, since the alpha floor comes from the Quoter).
- A quote requires `user` (the order's EVM `recipient`), as with any Substrate payout.

## Errors

Every failure is a `TaoIntentsError` with a stable `code`; nothing is opened on-chain after a failed quote.

| Class | `code` | Typical handling |
| --- | --- | --- |
| `InvalidParamsError` | `INVALID_PARAMS` | Fix the input (bad address, amount, deadline). |
| `UnsupportedRouteError` | `UNSUPPORTED_ROUTE` | Unknown chain/token, same-chain, or a swap input on a chain with no Uniswap deployment. |
| `SwapQuoteError` | `SWAP_QUOTE_FAILED` | A non-USDC input can't be priced into USDC (no pool liquidity, RPC failure, absurd floor). Nothing was sent or approved. |
| `QuoterError` | `QUOTER_ERROR` | Has `status`, `apiError`, `failures`, `retryable`, `paused`. |
| `QuoterError` | `QUOTER_FORBIDDEN` | HTTP 403: your origin/network is blocked. Not retryable; `blocked` is `true`. |
| `QuoterError` | `QUOTER_UNREACHABLE` | No response at all. In a browser this is either being offline or a CORS / allow-list block (indistinguishable), so the message says both. `blocked` is `true`. |
| `QuoteExpiredError` | `QUOTE_EXPIRED` | Request a new quote. |
| `IndicativeQuoteError` | `INDICATIVE_QUOTE` | Re-quote with `user`. |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Has `required` / `available`, for the token being paid (or the alpha stake). |
| `InsufficientGasError` | `INSUFFICIENT_GAS` | User needs native token for gas. |
| `UserRejectedError` | `USER_REJECTED` | User dismissed the wallet prompt. |
| `ContractRevertError` | `CONTRACT_REVERT` | Has `errorName` (e.g. `FullSettler__ProtocolFeeExceedsMax`) and a readable message. |
| `TransactionRevertedError` | `TRANSACTION_REVERTED` | Mined but reverted; has `txHash`. |
| `WalletError` | `WALLET_ERROR` | Wallet/network problem. |
| `SubstrateError` | `SUBSTRATE_ERROR` | Signing or submitting the Substrate extrinsic failed; `dispatchError` / `extrinsicHash` when known. |
| `EvmCallFailedError` | `EVM_CALL_FAILED` | The Substrate batch ran but `open` didn't (reverted inside the EVM, or no `Open` event). Nothing was opened. |
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
