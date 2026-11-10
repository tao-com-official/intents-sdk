import type { Address } from "viem";
import { TYPEHASH_16AE, TYPEHASH_9737, type OrderTypehash } from "./abi";
import type { ChainConfig } from "./config";
import { UnsupportedRouteError } from "./errors";

/**
 * Every FullSettler the SDK knows, by order format (`OrderTypehash`) and chain. The Quoter only says *which*
 * address is live; this table says how to talk to it, so a migration to a new settler needs no SDK release as
 * long as the new address is listed here ahead of time.
 */
export const KNOWN_SETTLERS: Record<OrderTypehash, Record<number, Address[]>> = {
  [TYPEHASH_16AE]: {
    1: ["0x2831Ea5524f171735aF8FEB2e331821bef176C8A"],
    964: ["0x24834012973b6e70997a23C7aAB01481d46CB8E1"],
  },
  [TYPEHASH_9737]: {
    // TODO: add the refundTo settlers once they are deployed.
    1: [],
    964: [],
  },
};

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
  known?: Record<OrderTypehash, Record<number, Address[]>>;
}

/**
 * Finds the settler each chain runs, so the SDK follows a migration without a new release. Settlers change
 * rarely, so each chain is looked up once per instance; only a failed lookup is tried again on the next call.
 */
export class SettlerRegistry {
  readonly #opts: SettlerRegistryOptions;
  readonly #live = new Map<number, Promise<Address | undefined>>();

  constructor(opts: SettlerRegistryOptions) {
    this.#opts = opts;
  }

  /**
   * `chain` with `intents` replaced by the settler live on it and that settler's order format. Falls back to the
   * configured address when the lookup is off or fails.
   */
  async resolve(chain: ChainConfig): Promise<SettlerChain> {
    let address = chain.intents;
    const { lookup } = this.#opts;
    if (lookup && !this.#opts.pinned.has(chain.id)) {
      let live = this.#live.get(chain.id);
      if (!live) {
        live = lookup(chain).catch(() => undefined);
        this.#live.set(chain.id, live);
      }
      const found = await live;
      // A lookup outage must not stop orders: use the configured address, and ask again next time.
      if (!found) this.#live.delete(chain.id);
      address = found ?? address;
    }
    return { ...chain, intents: address, orderTypehash: this.#formatOf(chain, address) };
  }

  #formatOf(chain: ChainConfig, address: Address): OrderTypehash {
    const known = this.#opts.known ?? KNOWN_SETTLERS;
    for (const typehash of Object.keys(known) as OrderTypehash[]) {
      if (known[typehash][chain.id]?.some((a) => a.toLowerCase() === address.toLowerCase())) return typehash;
    }
    if (chain.orderTypehash) return chain.orderTypehash;
    throw new UnsupportedRouteError(
      `The Intents contract on ${chain.name} (${address}) is not one this SDK version knows how to encode orders for. Update @tao.com/intents-sdk, or set \`chains[${chain.id}].orderTypehash\` if you deployed it yourself.`,
    );
  }
}
