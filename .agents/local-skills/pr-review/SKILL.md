---
name: pr-review
description: >-
  CI review of an @tao.com/intents-sdk pull request, run by the Claude Code Review workflow on every push. Checks
  over-engineering, task fitness against the PR description, public API and compatibility, code quality, a "name the
  bug" test audit and security for a browser-and-Node wallet SDK. Labels every finding blocker/major/nit with a stable
  fingerprint and ends with a machine-readable verdict block. Use when the workflow runs it or when asked to review a
  PR the way CI does.
allowed-tools: Read Grep Glob
---

# PR review

Review one pull request of `@tao.com/intents-sdk`: a TypeScript SDK (ESM + CJS, built with tsup, tested with vitest)
that quotes a cross-chain TAO intent through the Quoter API and opens it on-chain through an EIP-1193 wallet or a
viem `WalletClient`, including Substrate (Subtensor) signing. `viem` is a peer dependency; the package must stay free of
Node-only dependencies. The public API is whatever `src/index.ts` exports, documented in `README.md`.

Follow the [review contract](references/review-contract.md) for inputs, severity, fingerprints and the output format.
Read it first.

## 1. Over-engineering

What can be deleted? One line per finding: `<file>:L<line>: <tag> <what>. <replacement>.`

- `delete:` dead code, unused flexibility, a speculative feature. Replacement: nothing.
- `stdlib:` a hand-rolled thing the platform or TypeScript ships. Name the function.
- `native:` a dependency or code doing what `viem` or the platform already does (unit parsing and formatting, ABI
  encoding, address checks, chain definitions). Name it.
- `yagni:` an abstraction with one implementation, config nobody sets, a layer with one caller.
- `shrink:` the same logic in fewer lines. Show the shorter form.

End with `net: -<N> lines possible.` or `Lean already. Ship.` Anything matching
[unearned structure](references/review-contract.md#unearned-structure-blocks) is a `blocker`.

## 2. Task fitness

Treat the PR title and description as the task. Extract its goal, acceptance criteria and non-goals, then walk each
criterion:

| Status | Meaning |
|---|---|
| `pass` | The behaviour is clearly present in the diff |
| `gap` | Missing, partial or contradicted (`blocker`) |
| `unclear` | The code cannot show it; say what evidence would (see the contract for its severity) |
| `out-of-scope held` | A stated non-goal is correctly not implemented |

Also report overreach (code for something the description does not ask for) and anything the description promises
that the diff lacks. Cite files and symbols; never rubber-stamp.

## 3. Public API and compatibility

| Check | Typical severity |
|---|---|
| A removed or renamed export, a narrowed parameter type, a new required option, or a changed return shape or error class on the public API, without a major version bump in `package.json` and a note in the description | `blocker` |
| A new export or option without a `README.md` entry, or a README example that no longer type-checks against the code | `major` |
| A Node-only import (`node:*`, `fs`, `crypto` from Node, `Buffer` without a guard) in `src/` | `blocker` |
| A new runtime dependency, or `viem` moved out of `peerDependencies` | `blocker` unless the description justifies it |
| An internal helper exported from `src/index.ts` that consumers should not depend on | `major` |
| A `package.json` `exports`, `main`, `module`, `types` or `files` change that could break ESM or CJS consumers | `blocker` until shown to work |
| A version bump that does not match the change (semver) | `major` |

## 4. Code quality

| Rule | Warn (`major`) | Hard (`blocker`) |
|---|---|---|
| Cyclomatic complexity | > 10 | > 15 |
| Function length | > 40 lines | > 75 lines |
| Argument count (positional) | > 4 | > 6 |
| Hardcoded secret, API key or environment-specific URL in logic | | any |

Also flag magic numbers and strings, boolean flag parameters, swallowed errors, duplicated logic and unclear naming
(`major` or `nit`), and this repo's conventions (`major` unless they break behaviour):

- TypeScript strict: no `any`, no unchecked non-null assertions, return types on exported functions.
- Amounts are `bigint` in base units internally; conversion to and from human strings goes through `viem`
  (`parseUnits`/`formatUnits`) with the token's decimals, never through `Number` or floating point.
- Errors thrown to consumers are the SDK's own classes from `src/errors.ts`, with enough context to act on.
- Async work that waits (polling, settlement, wallet prompts) honours the caller's `AbortSignal` (`src/abort.ts`).
- Comments only where the why is not obvious; no stray `TODO`/`FIXME` without a ticket.

## 5. Test audit

Audit tests by the defects they would catch. For each new or changed behaviour, answer:

1. **What is the plausible wrong answer?** The specific way it could compute something incorrect and still run: an
   inverted comparison, an off-by-one at a boundary, wrong decimals (6 vs 18 vs 9), rao vs TAO, rounding the wrong way,
   truncating a `bigint`, the wrong chain ID or contract address, an approval for the wrong spender or amount, a
   missing chain switch, a deadline or slippage applied the wrong way.
2. **Which test fails if that happens?** Name it. If none does, that is a missing test: a `blocker` when the behaviour
   touches amounts, approvals, signing, order data encoding, chain selection or a new branch or error path; otherwise
   `major`.

Then check:

- **Suite:** the suite result the workflow gives you. A failed step is a `blocker`: name the failing test or
  compiler error from `suite-log.txt`.
- **Missing tests:** acceptance criteria, new branches and error paths with no test under `test/`.
- **Useless tests:** tests that cannot fail meaningfully, assert only mocks, restate the implementation, or duplicate
  another (`major`).
- **Encoding:** a change to ABI or order-data encoding (`src/abi.ts`, `src/order-data.ts`, `src/evm-call.ts`,
  `src/substrate.ts`) is tested against fixed expected bytes or a decode round-trip, not only against itself.
- **Shared output changes:** when a shared function's output changes, its literal expected values are updated across
  `test/**` (`major`).

## 6. Security

This SDK runs in users' browsers next to their wallets. Then:

- A transaction, approval or signature request whose target, amount or calldata comes from the Quoter API (or any
  remote response) without validating it against what the caller asked for (chain, token, amount bounds, known
  contract addresses): `blocker`.
- An unlimited (`maxUint256`) approval where an exact one would do, unless the caller opts in: `blocker`.
- External data (Quoter API responses, RPC results) used without validation of shape and types: `major`, `blocker`
  when it reaches a transaction.
- A private key, mnemonic or API key logged, put in an error message, or sent anywhere: `blocker`.
- A user-supplied value interpolated into a URL path or query without encoding: `major`.
- `console` output in library code outside an opt-in debug hook: `nit`, `major` when it prints wallet data.

## Sections of `review-body.md`

`### Over-engineering`, `### Task fitness` (table), `### Public API` (table: change, compatible?, notes),
`### Code quality` (table: location, rule, value, verdict), `### Test audit` (table: behaviour, plausible wrong answer,
test that catches it or **none**, then missing and useless), `### Security`, then the findings table, the quick fix
prompt and the verdict block as the [contract](references/review-contract.md#output) defines.
