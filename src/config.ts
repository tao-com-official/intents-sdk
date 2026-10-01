import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";
import { mainnet } from "viem/chains";
import { InvalidParamsError, UnsupportedRouteError } from "./errors";

/** Placeholder address the contract and Quoter API use for the chain's native token. */
export const NATIVE_TOKEN_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const DEFAULT_QUOTER_URL = "https://www.tao.com/api/v1/intents/quotes";

export interface TokenInfo {
  chainId: number;
  symbol: string;
  name?: string;
  address: Address;
  /** `undefined` only for unknown tokens passed by raw address. */
  decimals: number | undefined;
  isNative: boolean;
}

export interface KnownToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  isNative?: boolean;
  /** Whether it can be used as the input (paid) token. Only USDC today. */
  input?: boolean;
}

export interface ChainConfig {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Default RPC used for reads. Override with `rpcUrls` on the client. */
  rpcUrl?: string;
  explorerUrl: string;
  /** The Intents contract (FullSettler). */
  intents: Address;
  usdc: Address;
  tokens: KnownToken[];
}

export const ETHEREUM = 1;
export const SUBTENSOR_EVM = 964;

const USDC_ETH: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SUBTENSOR: Address = "0x9001dbe4D68d36ab87923A2a9Dfb0c745fd25001";

/** Mainnet deployments, per the TAO Intents docs. */
export const DEFAULT_CHAINS: Record<number, ChainConfig> = {
  [ETHEREUM]: {
    id: ETHEREUM,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerUrl: "https://etherscan.io",
    intents: "0x2831Ea5524f171735aF8FEB2e331821bef176C8A",
    usdc: USDC_ETH,
    tokens: [
      { symbol: "USDC", name: "USD Coin", address: USDC_ETH, decimals: 6, input: true },
      { symbol: "ETH", name: "Ether", address: NATIVE_TOKEN_ADDRESS, decimals: 18, isNative: true },
    ],
  },
  [SUBTENSOR_EVM]: {
    id: SUBTENSOR_EVM,
    name: "Subtensor EVM",
    nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 },
    rpcUrl: "https://lite.chain.opentensor.ai",
    explorerUrl: "https://evm.taostats.io",
    intents: "0x24834012973b6e70997a23C7aAB01481d46CB8E1",
    usdc: USDC_SUBTENSOR,
    tokens: [
      // On-chain symbol is `USDC.e`; we expose it as USDC like the docs do.
      { symbol: "USDC", name: "USDC.e", address: USDC_SUBTENSOR, decimals: 6, input: true },
      { symbol: "wTAO", name: "Wrapped TAO", address: "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e", decimals: 18 },
      { symbol: "TAO", name: "TAO", address: NATIVE_TOKEN_ADDRESS, decimals: 18, isNative: true },
    ],
  },
};

/** Per-chain overrides: point at a fork, a different deployment, or add tokens. */
export type ChainOverrides = Partial<Omit<ChainConfig, "id">>;

export function buildChains(overrides: Record<number, ChainOverrides> = {}, rpcUrls: Record<number, string> = {}) {
  const chains: Record<number, ChainConfig> = {};
  for (const [id, base] of Object.entries(DEFAULT_CHAINS)) chains[Number(id)] = { ...base };
  for (const [id, o] of Object.entries(overrides)) {
    const chainId = Number(id);
    const base = chains[chainId];
    if (!base) {
      const { name, nativeCurrency, intents, usdc, explorerUrl } = o;
      if (!name || !nativeCurrency || !intents || !usdc) {
        throw new InvalidParamsError(
          `Chain ${chainId} is not built in. Provide name, nativeCurrency, intents and usdc to add it.`,
        );
      }
      chains[chainId] = { id: chainId, tokens: [], explorerUrl: explorerUrl ?? "", ...o, name, nativeCurrency, intents, usdc };
    } else {
      chains[chainId] = { ...base, ...o, id: chainId };
    }
  }
  for (const [id, url] of Object.entries(rpcUrls)) {
    const chain = chains[Number(id)];
    if (chain) chain.rpcUrl = url;
    else throw new InvalidParamsError(`rpcUrls: unknown chain ${id}.`);
  }
  return chains;
}

export function toViemChain(config: ChainConfig): Chain {
  if (config.id === ETHEREUM && !config.rpcUrl) return mainnet;
  const rpc = config.rpcUrl ? [config.rpcUrl] : [];
  return defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: rpc } },
    blockExplorers: config.explorerUrl ? { default: { name: "Explorer", url: config.explorerUrl } } : undefined,
  });
}

export function getChainConfig(chains: Record<number, ChainConfig>, chainId: number): ChainConfig {
  const chain = chains[chainId];
  if (!chain) {
    const supported = Object.values(chains)
      .map((c) => `${c.name} (${c.id})`)
      .join(", ");
    throw new UnsupportedRouteError(`Chain ${chainId} is not supported. Supported chains: ${supported}.`);
  }
  return chain;
}

/**
 * Resolve a token given as a symbol (`"USDC"`, `"TAO"`) or an address.
 * Unknown addresses are accepted (the Quoter decides whether it can serve them) but have no decimals.
 */
export function resolveToken(chain: ChainConfig, token: string): TokenInfo {
  if (isAddress(token, { strict: false })) {
    const address = getAddress(token);
    const known = chain.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
    if (known) return toTokenInfo(chain.id, known);
    return { chainId: chain.id, symbol: address, address, decimals: undefined, isNative: false };
  }
  const bySymbol = chain.tokens.find((t) => t.symbol.toLowerCase() === token.toLowerCase());
  if (!bySymbol) {
    const symbols = chain.tokens.map((t) => t.symbol).join(", ");
    throw new UnsupportedRouteError(`Unknown token "${token}" on ${chain.name}. Known tokens: ${symbols}, or pass an address.`);
  }
  return toTokenInfo(chain.id, bySymbol);
}

function toTokenInfo(chainId: number, t: KnownToken): TokenInfo {
  return {
    chainId,
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    isNative: Boolean(t.isNative),
  };
}
