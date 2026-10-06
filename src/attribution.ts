import { stringToHex, type Hex } from "viem";
import { InvalidParamsError } from "./errors";

/** ERC-8021 marker: the 16 bytes that end every attributed calldata. */
const ERC_8021_MARKER = "80218021802180218021802180218021";
/** Schema 0: `codes` is an ASCII, comma-delimited list. */
const SCHEMA_ID = "00";

/**
 * Build the ERC-8021 (schema 0) calldata suffix for a single attribution code:
 * `codes ‖ codesLength (1 byte) ‖ schemaId (0x00) ‖ marker`. Append it to the transaction's calldata;
 * the contract ignores the extra trailing bytes.
 */
export function buildAttributionSuffix(code: string): Hex {
  if (typeof code !== "string" || code.length === 0) {
    throw new InvalidParamsError("`partnerId` must be a non-empty string.");
  }
  if (!/^[\x21-\x7e]+$/.test(code) || code.includes(",")) {
    throw new InvalidParamsError("`partnerId` must be printable ASCII without spaces or commas.");
  }
  if (code.length > 255) {
    throw new InvalidParamsError("`partnerId` must be at most 255 characters.");
  }
  const length = code.length.toString(16).padStart(2, "0");
  return `${stringToHex(code)}${length}${SCHEMA_ID}${ERC_8021_MARKER}` as Hex;
}
