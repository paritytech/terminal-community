// e2e/host/payer.ts — Node side: plays the customer's Polkadot app.
// Independent sender implementation of the W3S cheque (the app only has the
// decrypt side), so a wire drift on either end fails the e2e.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { Bytes, Struct, Vector, str, u64 } from "scale-ts";

const Envelope = Struct({ encryptedData: Bytes(), ephemeralPublicKey: Bytes(32) });
const PaymentData = Struct({ amount: str, timestamp: u64, coins: Vector(Bytes()), id: str });

export interface ChequeRequest { id: string; amount: string; key: Uint8Array; name?: string; raw: string }

export function parseChequeDeeplink(raw: string): ChequeRequest {
  const url = new URL(raw);
  if (url.protocol !== "polkadotapp:" || url.host !== "pay" || url.pathname !== "/cheque") throw new Error(`not a cheque deeplink: ${raw}`);
  const p = url.searchParams;
  const b64 = p.get("key")!.replace(/-/g, "+").replace(/_/g, "/");
  return { id: p.get("id")!, amount: p.get("amount")!, key: Uint8Array.from(Buffer.from(b64, "base64")), name: p.get("name") ?? undefined, raw };
}

export const topicFor = (id: string) => blake2b256(new TextEncoder().encode(`pay-w3s:${id}`));
export const topUpIdFor = (id: string, attempt: number) =>
  blake2b256(new TextEncoder().encode(`pay-w3s-topup:${id}:${attempt}`));

export function randomCoins(n: number): Uint8Array[] {
  return Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(64)));
}

/** Encrypt a cheque for the terminal's ephemeral key. Overrides let specs send wrong id/amount/garbage. */
export function buildCheque(req: ChequeRequest, coins: Uint8Array[], over: Partial<{ id: string; amount: string; timestamp: bigint }> = {}) {
  const eph = x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(eph, req.key);
  const aeadKey = hkdf(sha256, shared, new Uint8Array(0), new Uint8Array(0), 32);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = PaymentData.enc({
    amount: over.amount ?? req.amount,
    timestamp: over.timestamp ?? BigInt(Date.now()),
    coins,
    id: over.id ?? req.id,
  });
  const sealed = chacha20poly1305(aeadKey, nonce).encrypt(plaintext);
  const blob = new Uint8Array(12 + sealed.length);
  blob.set(nonce);
  blob.set(sealed, 12);
  return {
    topic: topicFor(req.id),
    data: Envelope.enc({ encryptedData: blob, ephemeralPublicKey: x25519.getPublicKey(eph) }),
  };
}
