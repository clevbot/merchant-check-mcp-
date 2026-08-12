/**
 * Chain detection and address normalization, shared by every module that
 * touches a wallet address now that this store holds both Base and Solana
 * wallets in one table (see db/schema.sql `chain` column).
 *
 * Important and easy to get wrong: EVM addresses are functionally
 * case-insensitive (this codebase has always lowercased them for
 * consistent lookups), but Solana addresses are base58-encoded and
 * case-SENSITIVE — lowercasing one silently corrupts it into a different,
 * likely-invalid address. Every wallet_address read/write must go through
 * normalizeAddress() below rather than a bare `.toLowerCase()`, or Solana
 * lookups will intermittently fail in a way that's easy to miss in testing
 * with a handful of addresses and only surfaces at real scale.
 */

export type Chain = "base" | "solana";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Base58 alphabet excludes 0, O, I, l (visually ambiguous characters) by
// design. Solana pubkeys are 32-byte values, base58-encoded to 32-44 chars.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Format alone disambiguates the two — 0x-hex and base58 charsets don't overlap. */
export function detectChain(address: string): Chain | null {
  if (EVM_ADDRESS_RE.test(address)) return "base";
  if (SOLANA_ADDRESS_RE.test(address)) return "solana";
  return null;
}

export function isValidWalletAddress(address: string): boolean {
  return detectChain(address) !== null;
}

/** Base addresses are lowercased for consistent lookups; Solana addresses are returned as-is. */
export function normalizeAddress(address: string, chain: Chain): string {
  return chain === "base" ? address.toLowerCase() : address;
}

/**
 * Convenience for callers that don't already know the chain — detects then
 * normalizes. Returns null for an address that matches neither format.
 */
export function detectAndNormalize(address: string): { chain: Chain; normalized: string } | null {
  const chain = detectChain(address);
  if (!chain) return null;
  return { chain, normalized: normalizeAddress(address, chain) };
}
