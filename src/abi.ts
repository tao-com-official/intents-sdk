import { parseAbi, parseAbiParameters } from "viem";

/** What every FullSettler version shares: the functions the SDK calls, `Open`, and the errors it decodes. */
const settlerAbiItems = [
  "function open((uint32 fillDeadline, bytes32 orderDataType, bytes orderData) order) payable",
  "function ONCHAIN_ORDER_DATA_TYPEHASH() view returns (bytes32)",
  "function protocolFeeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function orderStatus(bytes32 orderId) view returns (uint8)",
  "function fillRecords(bytes32 orderId) view returns (bytes32)",
  "struct Output { bytes32 token; uint256 amount; bytes32 recipient; uint256 chainId; }",
  "struct FillInstruction { uint256 destinationChainId; bytes32 destinationSettler; bytes originData; }",
  "struct ResolvedCrossChainOrder { address user; uint256 originChainId; uint32 openDeadline; uint32 fillDeadline; bytes32 orderId; Output[] maxSpent; Output[] minReceived; FillInstruction[] fillInstructions; }",
  "event Open(bytes32 indexed orderId, ResolvedCrossChainOrder resolvedOrder)",
  "error EnforcedPause()",
  "error FullSettler__InvalidOrderDataType()",
  "error FullSettler__InvalidOrderUser()",
  "error FullSettler__InvalidInputToken()",
  "error FullSettler__InvalidAmount()",
  "error FullSettler__TimestampPassed()",
  "error FullSettler__FillDeadlineTooFar()",
  "error FullSettler__DestinationSettlerNotSet()",
  "error FullSettler__NonCanonicalRecipient()",
  "error FullSettler__ProtocolFeeExceedsMax()",
  "error FullSettler__InvalidCall()",
  "error FullSettler__SwapRouterNotSet()",
  "error FullSettler__SwapAmountTooLow()",
  "error SubtensorStakingLib__LowerThanExpectedTaoAfterUnstake()",
  "error SubtensorStakingLib__InvalidAmount()",
] as const;

/** `ONCHAIN_ORDER_DATA_TYPEHASH` of the settlers whose `InputOrderData` ends at `subtensorData` (`inputOrderDataParams`). */
export const TYPEHASH_16AE = "0x16ae6d72c870b510827ad4194540bb76d6a1f82d9d78806f182e19cafb7cdbf7";

/** `ONCHAIN_ORDER_DATA_TYPEHASH` of the settlers whose `InputOrderData` adds `refundTo` (`inputOrderData9737Params`). */
export const TYPEHASH_9737 = "0x9737b0b362a744b403d9e7aec36e74569a858b0731f589837af18740ee3a3df3";

/** Identifies a settler's order format: the `ONCHAIN_ORDER_DATA_TYPEHASH` it was deployed with. */
export type OrderTypehash = typeof TYPEHASH_16AE | typeof TYPEHASH_9737;

/** Minimal Intents (FullSettler) ABI, taken from the TAO Intents docs. */
export const intentsAbi = parseAbi([
  ...settlerAbiItems,
  "event Refunded(bytes32 indexed orderId, address indexed user, uint256 amount)",
]);

/**
 * FullSettler ABI for `TYPEHASH_9737` settlers, which take `refundTo`. The functions are the same as
 * `intentsAbi`'s; `Refunded` also names the address paid, and `open` can reject the refund address.
 */
export const intentsAbi9737 = parseAbi([
  ...settlerAbiItems,
  "event Refunded(bytes32 indexed orderId, address indexed user, address indexed recipient, uint256 amount)",
  "error FullSettler__InvalidRefundTo()",
]);

/** `InputOrderData` must be encoded as ONE tuple (like Solidity's `abi.encode(struct)`). */
export const inputOrderDataParams = parseAbiParameters(
  "(address user, address inputTokenToSwapFrom, uint24 poolFee, uint256 inputAmountToSwapFrom, uint32 swapDeadline, address inputToken, uint256 inputAmount, address outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 recipient, uint16 maxProtocolFeeBps, bytes subtensorData) order",
);

/** `InputOrderData` for `TYPEHASH_9737` settlers: the same tuple with the refund address appended. */
export const inputOrderData9737Params = parseAbiParameters(
  "(address user, address inputTokenToSwapFrom, uint24 poolFee, uint256 inputAmountToSwapFrom, uint32 swapDeadline, address inputToken, uint256 inputAmount, address outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 recipient, uint16 maxProtocolFeeBps, bytes subtensorData, address refundTo) order",
);

/** TaoFullSettler `SubtensorData`: ABI-encoded into `InputOrderData.subtensorData`. */
export const subtensorDataParams = parseAbiParameters(
  "(uint8 operationType, uint32 netuid, bytes32 delegatorHotkey, bytes32 recipientColdkey, uint256 amount) data",
);

/** `SubtensorData.operationType` values the SDK uses: `AlphaStake` (stake into a subnet) and `TransferTao` (native TAO to a coldkey). */
export const SUBTENSOR_OP_ALPHA_STAKE = 1;
export const SUBTENSOR_OP_TRANSFER_TAO = 2;

/** `orderStatus(orderId)` values on the origin contract. */
export const ORDER_STATUS_DEPOSITED = 1;
export const ORDER_STATUS_REFUNDED = 3;

export const ZERO_HASH = `0x${"0".repeat(64)}` as const;
