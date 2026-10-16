import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { blake2b512, encodeSs58, parseSubstrateAddress } from "../src/substrate";

// //Alice
const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_KEY = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

describe("blake2b512", () => {
  it("matches the RFC 7693 test vector for 'abc'", () => {
    expect(bytesToHex(blake2b512(new TextEncoder().encode("abc")))).toBe(
      "0xba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });
});

describe("parseSubstrateAddress", () => {
  it("decodes SS58 to the AccountId32", () => {
    expect(parseSubstrateAddress(ALICE_SS58)).toEqual({ accountId: ALICE_KEY, ss58: ALICE_SS58 });
    expect(encodeSs58(ALICE_KEY)).toBe(ALICE_SS58);
  });
  it("accepts a 32-byte hex account, lowercased", () => {
    expect(parseSubstrateAddress(ALICE_KEY.toUpperCase().replace("0X", "0x"))).toEqual({ accountId: ALICE_KEY });
  });
  it("returns undefined for EVM addresses", () => {
    expect(parseSubstrateAddress("0x1111111111111111111111111111111111111111")).toBeUndefined();
  });
  it("rejects a mistyped SS58 address", () => {
    expect(() => parseSubstrateAddress(ALICE_SS58.slice(0, -1) + "R")).toThrow(/checksum/);
  });
});
