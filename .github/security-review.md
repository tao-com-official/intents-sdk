# Security review rules

The automated security review (`security-review / review`) reads this file from `main`. Where it
conflicts with the shared checklists, it wins. Each rule below is a finding when a diff breaks it:
name the `file:line` and the attack, meaning who sends what and what they get.

`@tao.com/intents-sdk` is a **public npm package** that third-party apps run in their users'
browsers. It never holds a key: the integrator's EVM wallet (EIP-1193 or a viem `WalletClient`) or
Substrate signer (`SubstrateSigner`, `polkadotSigner`) signs. But the SDK builds every approval,
`open` call and Substrate batch that wallet is asked to sign, so a bug here moves users' funds in
every app that installs the release. Treat a reachable break of these rules as a Security finding.

## What the wallet signs

- The transaction must match what the caller asked for and the quote it accepted: input token and
  amount, output token, `recipient`, `refundTo`, origin and destination chain, fill deadline and
  minimum output. Report any default, re-encode, rounding or unit change in between: USDC
  (6 decimals), wei (18), rao (9, `alpha.ts`, `wst.ts`), vault units (1e9 token wei), and any
  `Number` or floating-point maths on an amount. Amounts stay `bigint`.
- Approvals (`client.ts`) approve **exactly** the input amount, to the settler the order opens on.
  An unlimited approval, a wider spender, or approving before the first quote succeeds is a finding.
- The settler and token addresses come only from the frozen allowlist in `src/deployments.ts` and
  `src/config.ts`. An address taken from a Quoter response, a URL or a caller option that isn't
  checked against that list is a finding, and so is any change to the list itself unless the PR
  links the deployment (docs or the contracts repo) it comes from.
- Swap floors (`swap.ts`, `order-data.ts`): a change that lowers or removes the minimum output, the
  sanity bound against the Quoter's promised output, or the slippage check can let a drained pool
  or a hostile quote take the user's input.
- Substrate opens (`evm-call.ts`, `substrate.ts`, `substrate-signer.ts`): the `utility.batchAll`
  moves exactly the alpha or TAO the order spends, to the H160 derived from the signer's own public
  key, and nothing else. SS58 checksums are verified, never skipped, because funds sent to a
  mistyped address are lost.
- Calldata suffixes (`attribution.ts`) only append the ERC-8021 code; they never change the call.

## Remote data is untrusted

- The Quoter API (`DEFAULT_QUOTER_URL` or the caller's `quoterUrl`) and RPC responses are parsed and
  checked before they reach a transaction: quote expiry, chain IDs, token and settler addresses,
  amounts. A field used without that check is a finding.
- Never open an intent after a failed or indicative quote (`QuoteUnavailableError`, a quote without
  `user`).

## Secrets and logging

- The SDK takes no API key and must not start sending one. Nothing it logs, throws or attaches to an
  error (`errors.ts`, `normalize.ts`) may include a signature, raw signed transaction, RPC URL with
  credentials in it, or a caller's custom headers.
- No `console.*` output of user addresses with amounts, and no telemetry or network call to any host
  the caller didn't configure.

## Supply chain and release

This package ships to the public registry with npm trusted publishing (OIDC), from `main` only,
through the `release` environment. In scope as well as `src/`: `.github/**`, `package.json`
(dependencies, `files`, `exports`, lifecycle scripts such as `prepublishOnly` or `postinstall`),
`package-lock.json`, `tsup.config.ts` and `.agents/**`. Look for a new runtime dependency (the SDK
has only `viem` as a peer), install scripts, `pull_request_target`, secrets reaching logs or
artifacts, untrusted input (PR titles, branch names, comment bodies) in `run:` lines, unpinned
actions, widened `permissions`, and anything that lets a publish run from a branch other than
`main` or outside the `release` environment.
