/** Machine-readable error codes. Switch on `error.code` to drive your UI. */
export type TaoIntentsErrorCode =
  | "INVALID_PARAMS"
  | "UNSUPPORTED_ROUTE"
  | "QUOTER_ERROR"
  | "QUOTE_EXPIRED"
  | "INDICATIVE_QUOTE"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_GAS"
  | "USER_REJECTED"
  | "CONTRACT_REVERT"
  | "TRANSACTION_REVERTED"
  | "WALLET_ERROR"
  | "ORDER_NOT_FOUND"
  | "ABORTED"
  | "TIMEOUT";

export class TaoIntentsError extends Error {
  readonly code: TaoIntentsErrorCode;

  constructor(code: TaoIntentsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export function isTaoIntentsError(error: unknown): error is TaoIntentsError {
  return error instanceof TaoIntentsError;
}

/** A parameter was malformed (bad address, non-positive amount, past deadline...). */
export class InvalidParamsError extends TaoIntentsError {
  constructor(message: string) {
    super("INVALID_PARAMS", message);
  }
}

/** The route (chains / tokens) can't be served by the SDK. */
export class UnsupportedRouteError extends TaoIntentsError {
  constructor(message: string) {
    super("UNSUPPORTED_ROUTE", message);
  }
}

export interface QuoterFailure {
  solverId?: number;
  kind?: string;
  code?: string;
  httpStatus?: number;
  [key: string]: unknown;
}

/** The Quoter API did not return a quote. Never open an intent after this. */
export class QuoterError extends TaoIntentsError {
  /** HTTP status, or 0 for network failures / timeouts. */
  readonly status: number;
  /** The API's `error` string, e.g. `ALL_SOLVERS_FAILED`, `RATE_LIMITED`, `SETTLER_PAUSED`. */
  readonly apiError: string | undefined;
  readonly failures: QuoterFailure[];
  /** True when retrying the same request shortly may succeed. */
  readonly retryable: boolean;
  /** True when the Intents contract on this route is paused. */
  readonly paused: boolean;

  constructor(init: {
    status: number;
    apiError?: string;
    message: string;
    failures?: QuoterFailure[];
    retryable: boolean;
    cause?: unknown;
  }) {
    super("QUOTER_ERROR", init.message, { cause: init.cause });
    this.status = init.status;
    this.apiError = init.apiError;
    this.failures = init.failures ?? [];
    this.retryable = init.retryable;
    this.paused = init.apiError === "SETTLER_PAUSED";
  }
}

/** The quote's `validUntil` has passed. Request a new quote. */
export class QuoteExpiredError extends TaoIntentsError {
  constructor(message = "The quote has expired. Request a new quote and try again.") {
    super("QUOTE_EXPIRED", message);
  }
}

/** A quote requested without `user` is only indicative and can't be used to open an order. */
export class IndicativeQuoteError extends TaoIntentsError {
  constructor() {
    super(
      "INDICATIVE_QUOTE",
      "This quote was requested without a `user` address, so it is indicative only. Request a quote with `user` set to open an intent.",
    );
  }
}

export class InsufficientBalanceError extends TaoIntentsError {
  readonly required: bigint;
  readonly available: bigint;
  constructor(required: bigint, available: bigint, symbol: string, decimals: number) {
    super(
      "INSUFFICIENT_BALANCE",
      `Insufficient ${symbol} balance: need ${formatAmount(required, decimals)}, have ${formatAmount(available, decimals)}.`,
    );
    this.required = required;
    this.available = available;
  }
}

export class InsufficientGasError extends TaoIntentsError {
  constructor(cause?: unknown) {
    super("INSUFFICIENT_GAS", "The wallet doesn't have enough native token to pay for gas.", { cause });
  }
}

/** The user dismissed the wallet prompt. */
export class UserRejectedError extends TaoIntentsError {
  constructor(cause?: unknown) {
    super("USER_REJECTED", "The request was rejected in the wallet.", { cause });
  }
}

/** A contract call was rejected during simulation. `errorName` is the Solidity custom error. */
export class ContractRevertError extends TaoIntentsError {
  readonly errorName: string | undefined;
  constructor(errorName: string | undefined, message: string, cause?: unknown) {
    super("CONTRACT_REVERT", message, { cause });
    this.errorName = errorName;
  }
}

/** The transaction was mined but reverted. */
export class TransactionRevertedError extends TaoIntentsError {
  readonly txHash: `0x${string}`;
  constructor(txHash: `0x${string}`, what: string) {
    super("TRANSACTION_REVERTED", `The ${what} transaction reverted on-chain (${txHash}).`);
    this.txHash = txHash;
  }
}

export class WalletError extends TaoIntentsError {
  constructor(message: string, cause?: unknown) {
    super("WALLET_ERROR", message, { cause });
  }
}

export class OrderNotFoundError extends TaoIntentsError {
  constructor(message: string) {
    super("ORDER_NOT_FOUND", message);
  }
}

export class AbortedError extends TaoIntentsError {
  constructor(message = "The operation was aborted.") {
    super("ABORTED", message);
  }
}

export class TimeoutError extends TaoIntentsError {
  constructor(message: string) {
    super("TIMEOUT", message);
  }
}

/** Human-readable explanations for the Intents contract's custom errors. */
export const REVERT_MESSAGES: Record<string, string> = {
  EnforcedPause: "The Intents contract is paused. Please try again later.",
  FullSettler__InvalidOrderDataType: "The order data type doesn't match the contract. This is an SDK bug; please report it.",
  FullSettler__InvalidOrderUser: "The order's user must be the connected wallet address.",
  FullSettler__InvalidInputToken: "The input token is not USDC on the origin chain.",
  FullSettler__InvalidAmount: "The input amount must be greater than zero.",
  FullSettler__TimestampPassed: "The fill deadline has already passed. Request a new quote.",
  FullSettler__FillDeadlineTooFar: "The fill deadline is more than 1 day in the future.",
  FullSettler__DestinationSettlerNotSet: "The destination chain is not supported from this origin chain.",
  FullSettler__NonCanonicalRecipient: "The recipient is not a valid address.",
  FullSettler__ProtocolFeeExceedsMax:
    "The protocol fee changed since the quote was requested. Request a new quote.",
  FullSettler__InvalidCall: "The order was rejected by the contract (invalid swap fields or native value sent).",
};

function formatAmount(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
