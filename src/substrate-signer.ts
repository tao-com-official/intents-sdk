import type { Hex } from "viem";
import { SubstrateError, UserRejectedError } from "./errors";

/** One extrinsic call, by pallet and method name, with its arguments. Hex strings are bytes / account ids. */
export interface SubstrateCall {
  section: string;
  method: string;
  args: unknown[];
}

/** An event of the included extrinsic. `data` holds plain JSON values (an `evm.Log` carries `{ address, topics, data }`). */
export interface SubstrateEvent {
  section: string;
  method: string;
  data: unknown[];
}

export interface SubstrateBatchResult {
  /** Hash of the extrinsic. */
  extrinsicHash: Hex;
  blockHash: Hex;
  /** Events of this extrinsic only. */
  events: SubstrateEvent[];
}

export interface SubstrateSignOptions {
  /** Called once the wallet returned a signature and the extrinsic is about to be broadcast. */
  onSigned?: (extrinsicHash: Hex) => void;
  /**
   * Last veto, run after the signature and before anything is broadcast: throw to abort and nothing reaches
   * the chain. It is the only point that sees how long the user took to confirm.
   */
  beforeSubmit?: () => void;
}

/**
 * Signs for a Substrate coldkey. The SDK builds the calls; this signs them, submits them and reports what
 * happened, so any Substrate library or wallet can back it. `polkadotSigner` implements it for polkadot-js.
 */
export interface SubstrateSigner {
  /** The coldkey that signs: an SS58 address or a 32-byte `0x` AccountId32. */
  readonly address: string;
  /**
   * Sign `calls` as one `utility.batchAll` (atomic: all of them land or none does), submit it, and resolve
   * once it is included in a block. Reject if it fails on-chain.
   */
  signAndSendBatch(calls: SubstrateCall[], options?: SubstrateSignOptions): Promise<SubstrateBatchResult>;
  /**
   * Optional. The rao the coldkey can move after paying the fee of this batch (free balance less what is
   * frozen, the existential deposit and the fee). Lets the SDK refuse before asking for a signature.
   */
  spendableAfterFee?(calls: SubstrateCall[]): Promise<bigint>;
}

// ------------------------------------------------------------------ polkadot-js adapter

const DEFAULT_ERA_PERIOD = 32;

/**
 * The slice of polkadot-js's `ApiPromise` the adapter uses. Declared structurally so the SDK needs no
 * dependency on `@polkadot/api`: pass your own `ApiPromise` (connected over WebSocket).
 */
export interface PolkadotApiLike {
  // `tx` and `query` are indexed by pallet and call name; typing them would mean importing polkadot's types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: any;
}

export interface PolkadotSignerOptions {
  api: PolkadotApiLike;
  /** The signing account: its address (with `signer`, e.g. an extension's `injector.signer`), or a keyring pair. */
  account: string | { address: string };
  /** polkadot-js `Signer` (e.g. `injector.signer` from `@polkadot/extension-dapp`). Not needed for a keyring pair. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signer?: any;
  /**
   * Mortal-era length in blocks (~12s each). Default 32 (~6.4 min), polkadot-js's own. The era starts when signing
   * starts and must outlast the wallet prompt; the SDK already vetoes a signature that leaves the order under 60s to
   * fill, so a longer era only keeps a signed batch valid longer in the pool. Raise it for a pinned, distant
   * `fillDeadline` or a slow signer (a signature that outlives its era is rejected as "bad signature").
   */
  eraPeriod?: number;
  /** Existential deposit (rao) kept out of `spendableAfterFee`. Default 500. */
  existentialDepositRao?: bigint;
}

/**
 * A `SubstrateSigner` backed by polkadot-js. Needs a WebSocket `api` (the batch is tracked through the
 * node's status subscription).
 *
 * ```ts
 * const api = await ApiPromise.create({ provider: new WsProvider("wss://entrypoint-finney.opentensor.ai:443") });
 * const injector = await web3FromAddress(address);
 * const substrate = polkadotSigner({ api, account: address, signer: injector.signer });
 * ```
 */
export function polkadotSigner(options: PolkadotSignerOptions): SubstrateSigner {
  const { api, account, signer } = options;
  const address = typeof account === "string" ? account : account.address;
  const eraPeriod = options.eraPeriod ?? DEFAULT_ERA_PERIOD;
  const existentialDeposit = options.existentialDepositRao ?? 500n;

  const build = (calls: SubstrateCall[]) =>
    api.tx.utility.batchAll(
      calls.map((c) => {
        const fn = api.tx[c.section]?.[c.method];
        if (typeof fn !== "function") {
          throw new SubstrateError(`The connected chain has no \`${c.section}.${c.method}\` call.`);
        }
        return fn(...c.args);
      }),
    );

  return {
    address,

    async signAndSendBatch(calls, opts = {}) {
      const tx = build(calls);
      let signed;
      try {
        signed = await tx.signAsync(account, {
          ...(signer ? { signer } : {}),
          // Ledger-backed signers return a whole signed transaction rather than a bare signature.
          withSignedTransaction: true,
          era: eraPeriod,
          nonce: -1,
        });
      } catch (cause) {
        throw isRejection(cause) ? new UserRejectedError(cause) : new SubstrateError(`Couldn't sign the batch: ${messageOf(cause)}`, { cause });
      }
      opts.beforeSubmit?.();
      const extrinsicHash = signed.hash.toHex() as Hex;
      opts.onSigned?.(extrinsicHash);

      return new Promise<SubstrateBatchResult>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        signed
          .send((result: PolkadotResult) => {
            if (result.dispatchError) {
              const detail = describeDispatchError(api, result.dispatchError);
              finish(() => reject(new SubstrateError(detail, { dispatchError: detail, extrinsicHash })));
              return;
            }
            const status = result.status;
            if (status.isInBlock || status.isFinalized) {
              const blockHash = (status.isInBlock ? status.asInBlock : status.asFinalized).toHex() as Hex;
              finish(() => resolve({ extrinsicHash, blockHash, events: result.events.map(toEvent) }));
            } else if (status.isDropped || status.isInvalid || status.isUsurped) {
              finish(() => reject(new SubstrateError(`The extrinsic was ${status.type.toLowerCase()} and will not be included.`, { extrinsicHash })));
            }
          })
          .catch((cause: unknown) => {
            finish(() =>
              reject(cause instanceof SubstrateError ? cause : new SubstrateError(`Couldn't submit the batch: ${messageOf(cause)}`, { cause, extrinsicHash })),
            );
          });
      });
    },

    async spendableAfterFee(calls) {
      const [info, accountInfo] = await Promise.all([build(calls).paymentInfo(account), api.query.system.account(address)]);
      const free = BigInt(accountInfo.data.free.toString());
      const frozen = BigInt(accountInfo.data.frozen.toString());
      // A keep-alive transfer can only spend `free - max(frozen, ED)`.
      const untouchable = frozen > existentialDeposit ? frozen : existentialDeposit;
      const spendable = free - untouchable - BigInt(info.partialFee.toString());
      return spendable > 0n ? spendable : 0n;
    },
  };
}

interface PolkadotResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchError?: any;
  status: {
    isInBlock: boolean;
    isFinalized: boolean;
    isDropped?: boolean;
    isInvalid?: boolean;
    isUsurped?: boolean;
    type: string;
    asInBlock: { toHex(): string };
    asFinalized: { toHex(): string };
  };
  events: Array<{ event: { section: string; method: string; data: readonly unknown[] } }>;
}

function toEvent(record: PolkadotResult["events"][number]): SubstrateEvent {
  const { section, method, data } = record.event;
  return {
    section,
    method,
    data: data.map((d) => (typeof (d as { toJSON?: unknown }).toJSON === "function" ? (d as { toJSON(): unknown }).toJSON() : d)),
  };
}

function describeDispatchError(api: PolkadotApiLike, dispatchError: { isModule?: boolean; asModule?: unknown; toString(): string }): string {
  try {
    if (dispatchError.isModule) {
      const decoded = api.registry.findMetaError(dispatchError.asModule);
      const docs = (decoded.docs as string[]).join(" ").trim();
      return `${decoded.section}.${decoded.name}${docs ? `: ${docs}` : ""}`;
    }
  } catch {
    // fall through to the raw form
  }
  return `chain.Unknown: ${dispatchError.toString()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRejection(error: unknown): boolean {
  return /cancel|reject|denied|declin/i.test(messageOf(error));
}
