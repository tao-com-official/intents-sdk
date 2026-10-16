import { bytesToHex, hexToBytes, type Hex } from "viem";
import { InvalidParamsError } from "./errors";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_PREFIX = new TextEncoder().encode("SS58PRE");

/**
 * Parse a Substrate account given as an SS58 address (`5Grw...`) or a `0x` + 64-hex AccountId32 (the
 * public key / coldkey). Returns the 32-byte AccountId (plus the SS58 string if one was given), or `undefined` when `input` is neither.
 * An SS58 address with a bad checksum throws, since funds sent to a mistyped address are lost.
 */
export function parseSubstrateAddress(input: string): { accountId: Hex; ss58?: string } | undefined {
  const value = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { accountId: value.toLowerCase() as Hex };
  if (value.startsWith("0x") || !/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(value)) return undefined;
  return { accountId: decodeSs58(value), ss58: value };
}

/** Encode a 32-byte AccountId as an SS58 address (generic Substrate prefix 42, which Bittensor uses). */
export function encodeSs58(accountId: Hex, prefix = 42): string {
  const body = concat(new Uint8Array([prefix]), hexToBytes(accountId));
  const checksum = blake2b512(concat(SS58_PREFIX, body));
  return base58Encode(concat(body, checksum.subarray(0, 2)));
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  const zeros = bytes.findIndex((b) => b !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + out;
}

function decodeSs58(address: string): Hex {
  const bytes = base58Decode(address);
  // prefix (1 byte for network ids < 64, 2 bytes up to 16383) + 32-byte account + 2-byte checksum
  const prefixLength = bytes[0]! < 64 ? 1 : 2;
  if (bytes.length !== prefixLength + 32 + 2) {
    throw new InvalidParamsError("`recipient` is not a valid SS58 address (wrong length).");
  }
  const body = bytes.subarray(0, prefixLength + 32);
  const checksum = blake2b512(concat(SS58_PREFIX, body));
  if (bytes[body.length] !== checksum[0] || bytes[body.length + 1] !== checksum[1]) {
    throw new InvalidParamsError("`recipient` is not a valid SS58 address (checksum mismatch). Check for typos.");
  }
  return bytesToHex(body.subarray(prefixLength));
}

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const char of text) n = n * 58n + BigInt(BASE58.indexOf(char));
  const hex = n === 0n ? "" : n.toString(16);
  const body = hexToBytes(`0x${hex.length % 2 ? "0" : ""}${hex}`);
  const zeros = text.length - text.replace(/^1+/, "").length;
  return concat(new Uint8Array(zeros), body);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ---- BLAKE2b-512 (RFC 7693), only what SS58 checksums need: unkeyed, one-shot ----

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

export function blake2b512(input: Uint8Array): Uint8Array {
  const h = [...IV];
  h[0] = h[0]! ^ 0x01010040n; // digest length 64, no key, fanout 1, depth 1

  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    block.set(input.subarray(b * 128, (b + 1) * 128));
    const m: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      let word = 0n;
      for (let j = 7; j >= 0; j--) word = (word << 8n) | BigInt(block[i * 8 + j]!);
      m.push(word);
    }
    const last = b === blocks - 1;
    const t = BigInt(last ? input.length : (b + 1) * 128);
    const v = [...h, ...IV];
    v[12] = v[12]! ^ (t & MASK);
    v[13] = v[13]! ^ (t >> 64n);
    if (last) v[14] = v[14]! ^ MASK;

    const g = (a: number, bi: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a]! + v[bi]! + x) & MASK;
      v[d] = rotr(v[d]! ^ v[a]!, 32n);
      v[c] = (v[c]! + v[d]!) & MASK;
      v[bi] = rotr(v[bi]! ^ v[c]!, 24n);
      v[a] = (v[a]! + v[bi]! + y) & MASK;
      v[d] = rotr(v[d]! ^ v[a]!, 16n);
      v[c] = (v[c]! + v[d]!) & MASK;
      v[bi] = rotr(v[bi]! ^ v[c]!, 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10]!;
      g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
      g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
      g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
      g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
      g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
      g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
      g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
      g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
    }
    for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i]! >> BigInt(8 * j)) & 0xffn);
  return out;
}
