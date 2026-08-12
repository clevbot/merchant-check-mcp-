import { describe, expect, it } from "vitest";
import { detectAndNormalize, detectChain, isValidWalletAddress, normalizeAddress } from "../src/chains";

const BASE_MIXED_CASE = "0xFfC458db291b4ABce020Fe3De4F91f2770E537b1";
const SOLANA_ADDRESS = "DdeMfXrDae49VAkvVZHUhWh7FDuirAuFCuuJruqXv5G2";

describe("detectChain", () => {
  it("recognizes a well-formed EVM address as base", () => {
    expect(detectChain("0xffc458db291b4abce020fe3de4f91f2770e537b1")).toBe("base");
  });

  it("recognizes a well-formed Solana base58 address", () => {
    expect(detectChain(SOLANA_ADDRESS)).toBe("solana");
  });

  it("returns null for a malformed/unrecognized address", () => {
    expect(detectChain("not-an-address")).toBeNull();
    expect(detectChain("0x123")).toBeNull(); // too short for EVM
    expect(detectChain("")).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("lowercases Base addresses", () => {
    expect(normalizeAddress(BASE_MIXED_CASE, "base")).toBe(BASE_MIXED_CASE.toLowerCase());
  });

  it("leaves Solana addresses exactly as given (case-sensitive base58)", () => {
    expect(normalizeAddress(SOLANA_ADDRESS, "solana")).toBe(SOLANA_ADDRESS);
  });
});

describe("detectAndNormalize", () => {
  it("detects chain and normalizes a mixed-case Base address in one call", () => {
    const result = detectAndNormalize(BASE_MIXED_CASE);
    expect(result).toEqual({ chain: "base", normalized: BASE_MIXED_CASE.toLowerCase() });
  });

  it("does not corrupt a Solana address's case", () => {
    const result = detectAndNormalize(SOLANA_ADDRESS);
    expect(result).toEqual({ chain: "solana", normalized: SOLANA_ADDRESS });
  });

  it("returns null for an address matching neither chain's format", () => {
    expect(detectAndNormalize("totally invalid")).toBeNull();
  });
});

describe("isValidWalletAddress", () => {
  it("accepts both chains' formats", () => {
    expect(isValidWalletAddress(BASE_MIXED_CASE)).toBe(true);
    expect(isValidWalletAddress(SOLANA_ADDRESS)).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isValidWalletAddress("")).toBe(false);
    expect(isValidWalletAddress("0xnothex")).toBe(false);
  });
});
