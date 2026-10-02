import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Address, type Hex } from "viem";
import { vi } from "vitest";
import { intentsAbi } from "../src/abi";

export const USER: Address = "0x1111111111111111111111111111111111111111";
export const ETH_INTENTS: Address = "0x2831Ea5524f171735aF8FEB2e331821bef176C8A";
export const ORDER_ID: Hex = `0x${"ab".repeat(32)}`;
export const TYPEHASH: Hex = `0x${"cd".repeat(32)}`;
export const NOW = 1_800_000_000;

export function quoterBody(outputAmount = "320584403022379535", validUntil = NOW + 60) {
  return {
    quote: {
      validUntil,
      preview: {
        inputs: [{ asset: "0x0001", amount: "100000000", userPaysUsd: "99.99" }],
        outputs: [{ asset: "0x0002", amount: outputAmount, userReceivesUsd: "98.03" }],
      },
    },
    fees: { totalUsd: "1.96", effectiveRateBps: 196 },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A receipt log for `Open`, encoded exactly like the contract would emit it. */
export function openLog(opts: { fillDeadline: number; destinationChainId: number; address?: Address }) {
  const item = getAbiItem({ abi: intentsAbi, name: "Open" });
  const topics = encodeEventTopics({ abi: intentsAbi, eventName: "Open", args: { orderId: ORDER_ID } });
  const resolved = {
    user: USER,
    originChainId: 1n,
    openDeadline: opts.fillDeadline,
    fillDeadline: opts.fillDeadline,
    orderId: ORDER_ID,
    maxSpent: [],
    minReceived: [],
    fillInstructions: [
      { destinationChainId: BigInt(opts.destinationChainId), destinationSettler: `0x${"00".repeat(32)}` as Hex, originData: "0x" as Hex },
    ],
  };
  const data = encodeAbiParameters(
    item.inputs.filter((i) => !("indexed" in i && i.indexed)),
    [resolved],
  );
  return {
    address: opts.address ?? ETH_INTENTS,
    topics,
    data,
    blockNumber: 1n,
    transactionHash: `0x${"11".repeat(32)}` as Hex,
    transactionIndex: 0,
    blockHash: `0x${"22".repeat(32)}` as Hex,
    logIndex: 0,
    removed: false,
  };
}

export interface MockChainState {
  protocolFeeBps?: number;
  balance?: bigint;
  allowance?: bigint;
  fillRecord?: Hex;
  orderStatus?: number;
  simulateError?: unknown;
  logs?: ReturnType<typeof openLog>[];
}

export function mockPublicClient(state: MockChainState = {}) {
  const s = { protocolFeeBps: 30, balance: 1_000_000_000n, allowance: 0n, fillRecord: `0x${"0".repeat(64)}` as Hex, orderStatus: 1, ...state };
  const client = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "protocolFeeBps": return s.protocolFeeBps;
        case "ONCHAIN_ORDER_DATA_TYPEHASH": return TYPEHASH;
        case "balanceOf": return s.balance;
        case "allowance": return s.allowance;
        case "fillRecords": return s.fillRecord;
        case "orderStatus": return s.orderStatus;
        default: throw new Error(`unexpected read ${functionName}`);
      }
    }),
    simulateContract: vi.fn(async () => {
      if (s.simulateError) throw s.simulateError;
      return {};
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      status: "success" as const,
      transactionHash: hash,
      logs: s.logs ?? [],
    })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ status: "success" as const, transactionHash: hash, logs: s.logs ?? [] })),
  };
  return { client, state: s };
}

export function mockWalletClient(opts: { chainId?: number; account?: Address } = {}) {
  let chainId = opts.chainId ?? 1;
  const account = opts.account ?? USER;
  let n = 0;
  return {
    account: { address: account, type: "json-rpc" as const },
    getChainId: vi.fn(async () => chainId),
    switchChain: vi.fn(async ({ id }: { id: number }) => { chainId = id; }),
    addChain: vi.fn(async () => {}),
    requestAddresses: vi.fn(async () => [account]),
    writeContract: vi.fn(async (_args?: unknown) => `0x${(++n).toString(16).padStart(64, "0")}` as Hex),
  };
}
