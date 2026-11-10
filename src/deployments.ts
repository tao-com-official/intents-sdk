import type { Address } from "viem";
import { TYPEHASH_16AE, TYPEHASH_9737, type OrderTypehash } from "./abi";
import type { ChainConfig } from "./config";
import { UnsupportedRouteError } from "./errors";

/**
 * Every FullSettler the SDK knows, by order format (`OrderTypehash`) and chain. The Quoter only says *which*
 * address is live; this table says how to talk to it, so a migration to a new settler needs no SDK release as
 * long as the new address is listed here ahead of time. Frozen: it is the allowlist of addresses the SDK will
 * approve to and open orders on.
 */
export const KNOWN_SETTLERS: Readonly<Record<OrderTypehash, Readonly<Record<number, readonly Address[]>>>> = deepFreeze({
  [TYPEHASH_16AE]: {
    1: ["0x2831Ea5524f171735aF8FEB2e331821bef176C8A"],
    964: ["0x24834012973b6e70997a23C7aAB01481d46CB8E1"],
  },
  [TYPEHASH_9737]: {
    1: ["0x1252456515616DE1cFF3bc0a15CCF3b85Bf9294B"],
    964: ["0x2D3f088b124364C0002748dB5D0A30e82512efea"],
  },
});

/** How long a failed lookup is remembered before the Quoter is asked again. */
const LOOKUP_RETRY_SECONDS = 10;

/** A chain with the settler it currently runs. */
export type SettlerChain = ChainConfig & { orderTypehash: OrderTypehash };

export interface SettlerRegistryOptions {
  /**
   * Asks which settler a chain runs; `undefined` when it can't tell. `undefined` here turns the lookup off:
   * every chain uses its configured `intents`.
   */
  lookup: ((chain: ChainConfig) => Promise<Address | undefined>) | undefined;
  /** Chains whose `intents` the caller set by hand; they are never looked up. */
  pinned: ReadonlySet<number>;
  /** Current unix time in seconds. */
  now: () => number;
}

/**
 * Finds the settler each chain runs, so the SDK follows a migration without a new release. Settlers change
 * rarely, so each chain is looked up once per instance; a failed lookup is tried again after
 * `LOOKUP_RETRY_SECONDS`, not on every call (order polling would otherwise send a quote request per poll).
 */
export class SettlerRegistry {
  readonly #opts: SettlerRegistryOptions;
  readonly #live = new Map<number, Promise<Address | undefined>>();
  readonly #failedAt = new Map<number, number>();

  constructor(opts: SettlerRegistryOptions) {
    this.#opts = opts;
  }

  /**
   * `chain` with `intents` replaced by the settler live on it and that settler's order format. Falls back to the
   * configured address when the lookup is off or fails.
   */
  async resolve(chain: ChainConfig): Promise<SettlerChain> {
    const looked = this.#opts.pinned.has(chain.id) ? undefined : await this.#lookup(chain);
    const address = looked ?? chain.intents;
    return { ...chain, intents: address, orderTypehash: this.#formatOf(chain, address) };
  }

  /**
   * `resolve`, but with the settler a quote named (its `approvalSpender`) taking the lookup's place, so an order
   * goes where the Quoter priced it even if the lookup failed. Ignored for pinned chains or with the lookup off.
   */
  async resolveQuoted(chain: ChainConfig, quoted: Address | undefined): Promise<SettlerChain> {
    if (!quoted || !this.#opts.lookup || this.#opts.pinned.has(chain.id)) return this.resolve(chain);
    return { ...chain, intents: quoted, orderTypehash: this.#formatOf(chain, quoted) };
  }

  async #lookup(chain: ChainConfig): Promise<Address | undefined> {
    const { lookup, now } = this.#opts;
    if (!lookup) return undefined;
    const failedAt = this.#failedAt.get(chain.id);
    if (failedAt !== undefined && now() - failedAt < LOOKUP_RETRY_SECONDS) return undefined;
    let live = this.#live.get(chain.id);
    if (!live) {
      live = lookup(chain).catch(() => undefined);
      this.#live.set(chain.id, live);
    }
    const found = await live;
    // A lookup outage must not stop orders: use the configured address, and ask again after a while.
    if (!found && this.#live.get(chain.id) === live) {
      this.#live.delete(chain.id);
      this.#failedAt.set(chain.id, now());
    }
    return found;
  }

  #formatOf(chain: ChainConfig, address: Address): OrderTypehash {
    for (const typehash of Object.keys(KNOWN_SETTLERS) as OrderTypehash[]) {
      if (KNOWN_SETTLERS[typehash][chain.id]?.some((a) => sameAddress(a, address))) return typehash;
    }
    // Only for the address the caller configured: a Quoter-named address must be one the SDK lists.
    if (chain.orderTypehash && sameAddress(address, chain.intents)) return chain.orderTypehash;
    throw new UnsupportedRouteError(
      `The Intents contract on ${chain.name} (${address}) is not one this SDK version knows how to encode orders for. Update @tao.com/intents-sdk, or set \`chains[${chain.id}].intents\` and \`orderTypehash\` if you deployed it yourself.`,
    );
  }
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function deepFreeze<T extends Record<string, Record<number, Address[]>>>(table: T): T {
  for (const byChain of Object.values(table)) {
    for (const list of Object.values(byChain)) Object.freeze(list);
    Object.freeze(byChain);
  }
  return Object.freeze(table);
}
