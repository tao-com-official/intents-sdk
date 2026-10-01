import { BaseError, ContractFunctionRevertedError, InsufficientFundsError } from "viem";
import {
  ContractRevertError,
  InsufficientGasError,
  REVERT_MESSAGES,
  TaoIntentsError,
  UserRejectedError,
  WalletError,
} from "./errors";

/** Turn viem / wallet errors into the SDK's typed errors. SDK errors pass through untouched. */
export function normalizeError(error: unknown, action: string): TaoIntentsError {
  if (error instanceof TaoIntentsError) return error;

  if (isUserRejection(error)) return new UserRejectedError(error);

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const known = name ? REVERT_MESSAGES[name] : undefined;
      const message =
        known ??
        (name
          ? `The contract rejected the ${action}: ${name}.`
          : `The contract rejected the ${action}${revert.reason ? `: ${revert.reason}` : ""}. Check the token balance and allowance.`);
      return new ContractRevertError(name, message, error);
    }
    if (error.walk((e) => e instanceof InsufficientFundsError)) return new InsufficientGasError(error);
    return new WalletError(`Failed to ${action}: ${error.shortMessage}`, error);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new WalletError(`Failed to ${action}: ${message}`, error);
}

function isUserRejection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    const e = current as { code?: unknown; name?: string; cause?: unknown };
    // 4001 = EIP-1193 user rejected; ACTION_REJECTED = ethers-style
    if (e.code === 4001 || e.code === "ACTION_REJECTED" || e.name === "UserRejectedRequestError") return true;
    current = e.cause;
  }
  return false;
}
