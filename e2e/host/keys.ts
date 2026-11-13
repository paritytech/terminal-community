// e2e/host/keys.ts — pure-JS sr25519 product-account derivation, shared by
// the browser host page and Node-side specs.
import { HDKD, getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import { DEV_MINI_SECRET, blake2b256 } from "@polkadot-labs/hdkd-helpers";

const enc = new TextEncoder();

/** Substrate junction chain code for a string: SCALE(str), zero-padded to 32, or blake2b256 when longer. */
export function junction(text: string): Uint8Array {
  const bytes = enc.encode(text);
  if (bytes.length >= 64) throw new Error("junction too long for single-byte compact");
  const scale = new Uint8Array(1 + bytes.length);
  scale[0] = bytes.length << 2;
  scale.set(bytes, 1);
  if (scale.length > 32) return blake2b256(scale);
  const out = new Uint8Array(32);
  out.set(scale);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** `//Name` dev root — `//Bob` gives 0x8eaf…6a48 (verified against hdkd). */
export function devRoot(name: string): Uint8Array {
  const seed = typeof DEV_MINI_SECRET === "string" ? hexToBytes(DEV_MINI_SECRET) : (DEV_MINI_SECRET as Uint8Array);
  return HDKD.secretHard(secretFromSeed(seed), junction(name));
}

/** RFC-0022: `{root}//product//{productId}/{index32}`; `index32` from host-container's `derivationIndexBytes`. */
export function productSecret(root: Uint8Array, productId: string, index32: Uint8Array): Uint8Array {
  const hard = HDKD.secretHard(HDKD.secretHard(root, junction("product")), junction(productId));
  return HDKD.secretSoft(hard, index32);
}

export { getPublicKey, sign };
