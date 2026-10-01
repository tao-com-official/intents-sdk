import { parseAbi, parseAbiParameters } from "viem";

/** Minimal Intents (FullSettler) ABI, taken from the TAO Intents docs. */
export const intentsAbi = parseAbi([
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
  "event Refunded(bytes32 indexed orderId, address indexed user, uint256 amount)",
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
]);

/** `InputOrderData` must be encoded as ONE tuple (like Solidity's `abi.encode(struct)`). */
export const inputOrderDataParams = parseAbiParameters(
  "(address user, address inputTokenToSwapFrom, uint24 poolFee, uint256 inputAmountToSwapFrom, uint32 swapDeadline, address inputToken, uint256 inputAmount, address outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 recipient, uint16 maxProtocolFeeBps, bytes subtensorData) order",
);

/** `orderStatus(orderId)` values on the origin contract. */
export const ORDER_STATUS_DEPOSITED = 1;
export const ORDER_STATUS_REFUNDED = 3;

export const ZERO_HASH = `0x${"0".repeat(64)}` as const;
