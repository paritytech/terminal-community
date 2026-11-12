"use client";

/**
 * Host NFC bridge — lets the terminal present the *payment* deeplink over NFC
 * (Host Card Emulation) so a customer can tap their phone instead of scanning
 * the payment QR. The payload is the exact same deeplink encoded in that QR
 * (e.g. `polkadotapp://pay/cheque?id=…&amount=…&key=…`), passed verbatim — no
 * transformation — so the customer's phone opens the Polkadot app identically.
 *
 * Scope: PAYMENT ONLY — the cheque deeplink first shown to the customer to pay,
 * never the printed receipt.
 *
 * The capability lives on the same frozen `window.host.ext` object as `printer`.
 * `present` only exists on hosts built with the NFC bridge (this Sunmi/nightly+);
 * on Desktop / dot.li / older builds it is absent, so we feature-detect and fall
 * back to QR-only. There is no `isAvailable()` — "availability" is simply whether
 * the binding exists.
 *
 * Host contract:
 *   - present(uri): arm NFC with this deeplink (emit it on tap until clear()).
 *   - clear(): disarm / empty the tag.
 */

interface HostNfc {
  present(uri: string): Promise<void>;
  clear(): Promise<void>;
}

// `window.host.ext` is also augmented by lib/host/printing.ts; re-declaring it
// here would clash, so reach for the bridge through a local cast instead.
function getHostNfc(): HostNfc | null {
  if (typeof window === "undefined") return null;
  const nfc = (window as unknown as {
    host?: { ext?: { nfc?: Partial<HostNfc> } };
  }).host?.ext?.nfc;
  // Feature-detect: present() only exists on hosts built with the NFC bridge.
  return typeof nfc?.present === "function" ? (nfc as HostNfc) : null;
}

/**
 * Arm NFC with the payment deeplink. Fire-and-forget: no-ops when the host has
 * no NFC bridge, and rejects only if the host call itself fails — never block QR
 * rendering on it.
 */
export async function publishNfcPaymentDeeplink(deeplink: string): Promise<void> {
  const nfc = getHostNfc();
  if (!nfc || !deeplink) return;
  await nfc.present(deeplink);
}

/** Disarm / empty the tag. Safe to call when nothing is armed. */
export async function stopNfcEmitting(): Promise<void> {
  const nfc = getHostNfc();
  if (!nfc || typeof nfc.clear !== "function") return;
  try {
    await nfc.clear();
  } catch {
    // best-effort — never throw out of teardown
  }
}
