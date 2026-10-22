/**
 * Per-purchase ephemeral key + payment-id minting for the W3S Coinage flow.
 *
 * Each sale gets a fresh X25519 keypair and a fresh payment id (Appendix F of
 * "Merchant Payments W3S - Host & Terminal"; keys moved from secp256r1 to
 * X25519 with Polkadot App PR #973 so the flow works under SafetyNet). The
 * terminal publishes the raw 32-byte public key (RFC 7748 u-coordinate, no
 * point prefix) in the deeplink QR and keeps the private key in memory to
 * decrypt the incoming "cheque" envelope.
 *
 * Entropy: per the spec we source it from the host (`deriveEntropy`) when
 * running inside the Polkadot app. `deriveEntropy` is deterministic in its
 * input, so we feed it a fresh random label to get a fresh key each time, and
 * fall back to the label itself (browser CSPRNG) when standalone/dev.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { deriveHostEntropy } from "@/lib/host/payments";

/** X25519 private keys, public keys and agreement outputs are all 32 bytes. */
export const X25519_KEY_BYTES = 32;

export interface EphemeralKeypair {
  /** 32-byte X25519 private key — kept in memory, never leaves the device. */
  readonly privateKey: Uint8Array;
  /** 32-byte raw X25519 public key (RFC 7748 u-coordinate) — goes in the deeplink `key=`. */
  readonly publicKey: Uint8Array;
}

async function freshEntropy(): Promise<Uint8Array> {
  const label = crypto.getRandomValues(new Uint8Array(X25519_KEY_BYTES));
  // From the live client (lib/host/payments), which never throws. Null means
  // the host could not provide it — standalone, dev, or a host without the
  // slot — and the CSPRNG label, itself 32 bytes of secure randomness, stands.
  const derived = await deriveHostEntropy(label);
  if (derived && derived.length >= X25519_KEY_BYTES) {
    return derived.slice(0, X25519_KEY_BYTES);
  }
  return label;
}

/**
 * Mint a fresh X25519 keypair. Every 32-byte string is a valid X25519 private
 * key (RFC 7748 clamps it), so unlike the old P-256 path there is no invalid
 * scalar to retry on.
 */
export async function generateEphemeralKeypair(): Promise<EphemeralKeypair> {
  const privateKey = await freshEntropy();
  const publicKey = x25519.getPublicKey(privateKey);
  if (publicKey.length !== X25519_KEY_BYTES) {
    throw new Error(`X25519 public key unexpected length: ${publicKey.length}`);
  }
  return { privateKey, publicKey };
}

/**
 * A fresh payment id: 32 lowercase hex chars. Non-empty, lowercase
 * alphanumeric, and unique per purchase (Appendix F).
 */
export function generatePaymentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
