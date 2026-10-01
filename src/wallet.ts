import { createWalletClient, custom, getAddress, type Address, type Chain, type WalletClient } from "viem";
import { UserRejectedError, WalletError } from "./errors";
import { normalizeError } from "./normalize";
import type { Eip1193Provider, WalletLike } from "./types";

export interface ConnectedWallet {
  client: WalletClient;
  account: Address;
}

function isWalletClient(wallet: WalletLike): wallet is WalletClient {
  return typeof (wallet as WalletClient).writeContract === "function";
}

/** Normalize an EIP-1193 provider or viem WalletClient, and resolve the connected account. */
export async function connectWallet(wallet: WalletLike): Promise<ConnectedWallet> {
  let client: WalletClient;
  if (isWalletClient(wallet)) {
    client = wallet;
  } else if (wallet && typeof (wallet as Eip1193Provider).request === "function") {
    client = createWalletClient({ transport: custom(wallet as Eip1193Provider) });
  } else {
    throw new WalletError("`wallet` must be an EIP-1193 provider (e.g. window.ethereum) or a viem WalletClient.");
  }

  let account: Address | undefined = client.account?.address;
  if (!account) {
    try {
      // Prompts the user to connect if the wallet isn't connected yet.
      [account] = await client.requestAddresses();
    } catch (error) {
      throw normalizeError(error, "connect the wallet");
    }
  }
  if (!account) throw new WalletError("The wallet has no connected account.");
  return { client, account: getAddress(account) };
}

/** Make sure the wallet is on `chain`, switching (and adding the chain if needed). */
export async function ensureWalletChain(client: WalletClient, chain: Chain): Promise<void> {
  let current: number;
  try {
    current = await client.getChainId();
  } catch (error) {
    throw normalizeError(error, "read the wallet's network");
  }
  if (current === chain.id) return;

  try {
    await client.switchChain({ id: chain.id });
  } catch (error) {
    // 4902 / -32603 "Unrecognized chain": the wallet doesn't know this chain yet.
    if (isUnknownChain(error) && chain.rpcUrls.default.http.length > 0) {
      try {
        await client.addChain({ chain });
        return;
      } catch (addError) {
        throw normalizeError(addError, `add the ${chain.name} network to the wallet`);
      }
    }
    const normalized = normalizeError(error, `switch the wallet to ${chain.name}`);
    if (normalized instanceof UserRejectedError) throw normalized;
    throw new WalletError(
      `Please switch your wallet to ${chain.name} (chain ${chain.id}) and try again.`,
      error,
    );
  }
}

function isUnknownChain(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    const e = current as { code?: unknown; message?: string; cause?: unknown };
    if (e.code === 4902) return true;
    if (typeof e.message === "string" && /unrecognized chain|chain.*(not|hasn't been) added/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}
