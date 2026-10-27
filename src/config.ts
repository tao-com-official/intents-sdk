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
  /** Set for subnet alpha tokens (`"SN64"`): the subnet the output is staked into. */
  netuid?: number;
}

export interface KnownToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  isNative?: boolean;
  /**
   * Whether it can be used as the input (paid) token. Besides USDC (paid directly), the settler swaps native
   * and ERC-20 inputs to USDC through Uniswap V3 before escrowing, so those need a funded pool against USDC.
   */
  input?: boolean;
}

/**
 * Uniswap V3 deployment the settler swaps through when the input isn't USDC.
 */
export interface UniswapConfig {
  /** QuoterV2, used to size the minimum USDC the swap must return. */
  quoterV2: Address;
  /** The chain's wrapped native token (WETH / wTAO): what a native input is swapped as. */
  wrappedNative: Address;
  /** Fee tier tried first when pricing a swap; the other tiers are tried if it has no liquidity. */
  defaultFee: number;
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
  /** Whether native TAO can be delivered to a Substrate (SS58) coldkey on this chain. Subtensor EVM only. */
  substrateRecipients?: boolean;
  /** Whether a Substrate coldkey can open intents here through `evm.call`, without an EVM wallet. Subtensor EVM only. */
  substrateEvmCall?: boolean;
  /** Default validator hotkey (SS58) alpha is staked to when `alphaHotkey` isn't given. Subtensor EVM only. */
  defaultAlphaHotkey?: string;
  /** Uniswap V3 deployment for non-USDC inputs. Without it, only USDC can be paid on this chain. */
  uniswap?: UniswapConfig;
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
    uniswap: {
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      defaultFee: 500,
    },
    tokens: [
      { symbol: "USDC", name: "USD Coin", address: USDC_ETH, decimals: 6, input: true },
      { symbol: "ETH", name: "Ether", address: NATIVE_TOKEN_ADDRESS, decimals: 18, isNative: true, input: true },
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
    substrateRecipients: true,
    substrateEvmCall: true,
    // The official TAO.com validator.
    defaultAlphaHotkey: "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN",
    uniswap: {
      quoterV2: "0xC52476b7e73789f45E8bDe1863653439f1170d01",
      wrappedNative: "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e",
      // 3000, not 500: the 0.05% wTAO/USDC pool was drained in 2026-09 and quotes garbage on dust.
      defaultFee: 3_000,
    },
    tokens: [
      // On-chain symbol is `USDC.e`; we expose it as USDC like the docs do.
      { symbol: "USDC", name: "USDC.e", address: USDC_SUBTENSOR, decimals: 6, input: true },
      { symbol: "wTAO", name: "Wrapped TAO", address: "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e", decimals: 18, input: true },
      { symbol: "TAO", name: "TAO", address: NATIVE_TOKEN_ADDRESS, decimals: 18, isNative: true, input: true },
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
  const netuid = parseAlphaToken(token);
  if (netuid !== undefined) {
    if (!chain.substrateRecipients) {
      throw new UnsupportedRouteError(`${chain.name} can't deliver or take subnet alpha tokens. They are only available on Subtensor EVM.`);
    }
    // Alpha is staked, not transferred: the order names the native sentinel and the stake rides in `subtensorData`.
    return { chainId: chain.id, symbol: `SN${netuid}`, name: `Subnet ${netuid} alpha`, address: NATIVE_TOKEN_ADDRESS, decimals: 9, isNative: false, netuid };
  }
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

/** Highest netuid the SDK accepts (the contract takes a uint32; anything above this is treated as malformed). */
export const MAX_NETUID = 10_000;

/** `"SN64"` (any case) -> `64`; `undefined` when `token` isn't a subnet alpha symbol. SN0 is root stake. */
export function parseAlphaToken(token: string): number | undefined {
  const m = /^sn(\d+)$/i.exec(token.trim());
  if (!m) return undefined;
  const netuid = Number(m[1]);
  if (netuid > MAX_NETUID) throw new InvalidParamsError(`Subnet ${netuid} is out of range (0-${MAX_NETUID}).`);
  return netuid;
}
