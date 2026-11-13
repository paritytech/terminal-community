/// <reference types="node" />
// Helpers for the cheque-filter and cancel/limits specs.
import { expect, type Frame, type FrameLocator } from "@playwright/test";
import { x25519 } from "@noble/curves/ed25519.js";
import type { T3Host } from "../host/fixture";
import type { ChequeRequest } from "../host/payer";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

/**
 * Collects the product's `[coinage] …` console lines. The hook logs why it
 * skips each statement (decrypt failed / id mismatch / amount mismatch / no
 * data), which is the only proof a rejected cheque was actually looked at.
 */
export function coinageLog(host: T3Host) {
  const lines: string[] = [];
  host.page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[coinage]")) lines.push(text);
  });
  return {
    lines,
    /** Wait for a line matching `re` logged after `since` lines. */
    async waitFor(re: RegExp, since = 0, timeout = 15_000) {
      await expect
        .poll(() => lines.slice(since).some((l) => re.test(l)), { timeout, message: `console line ${re}` })
        .toBe(true);
    },
    mark: () => lines.length,
  };
}

/** The product document (a real Frame, for evaluate). */
export function productFrameHandle(host: T3Host): Frame {
  const frame = host.page.frames().find((f) => f !== host.page.mainFrame() && f.url().startsWith(PRODUCT_URL));
  if (!frame) throw new Error("product frame not found");
  return frame;
}

/**
 * Pin the next sale's payment id and QR key, so a spec can send the cheque
 * BEFORE the terminal subscribes to its topic. Makes the product's next
 * 32-byte `crypto.getRandomValues` (the entropy label) and next 16-byte one
 * (the payment id) return known bytes; every other call passes through.
 *
 * The label is the X25519 private key only when the host refuses to derive
 * entropy (the CSPRNG fallback in lib/payments/coinage/keys.ts), so the spec
 * must boot with `hostOptions: { entropyMode: "error" }`. The stub lives in
 * the current product document: after the Charge, call `expectPinTook` to
 * prove the document was not replaced and the label really reached the host.
 */
export async function pinNextPaymentRequest(
  host: T3Host,
  amount: string,
): Promise<ChequeRequest & { label: Uint8Array; pinnedAt: number }> {
  const label = crypto.getRandomValues(new Uint8Array(32));
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  const pinnedAt = host.mark();
  await productFrameHandle(host).evaluate(
    ({ label, idBytes }) => {
      const original = crypto.getRandomValues.bind(crypto);
      const queue = new Map<number, number[]>([[32, label], [16, idBytes]]);
      crypto.getRandomValues = (<T extends ArrayBufferView | null>(arr: T): T => {
        if (arr instanceof Uint8Array && queue.has(arr.length)) {
          arr.set(queue.get(arr.length)!);
          queue.delete(arr.length);
          if (queue.size === 0) crypto.getRandomValues = original;
          return arr;
        }
        return original(arr as never) as T;
      }) as typeof crypto.getRandomValues;
    },
    { label: [...label], idBytes: [...idBytes] },
  );
  return {
    id: Buffer.from(idBytes).toString("hex"),
    amount,
    key: x25519.getPublicKey(label),
    raw: "",
    label,
    pinnedAt,
  };
}

/**
 * After the Charge: the host was asked for entropy with the pinned label, and
 * no product document loaded since the pin (a reload would have dropped the
 * stub). The spec still checks the pinned id on the topUp and the sale.
 */
export async function expectPinTook(
  host: T3Host,
  req: Awaited<ReturnType<typeof pinNextPaymentRequest>>,
  since: number,
) {
  const entropy = await host.next("entropy", undefined, { since });
  expect(entropy.keyHex, "the pinned label was the entropy key").toBe("0x" + Buffer.from(req.label).toString("hex"));
  expect(host.events.slice(req.pinnedAt).filter((e) => e.type === "productLoad"), "product reloaded after the pin").toHaveLength(0);
}

/** A random X25519 public key nobody holds the secret for. */
export const strangerKey = () => x25519.getPublicKey(x25519.utils.randomSecretKey());

export const coinsHex = (coins: Uint8Array[]) => coins.map((c) => "0x" + Buffer.from(c).toString("hex"));

/** The three bottom-nav links. */
export function navLinks(frame: FrameLocator) {
  return {
    checkout: frame.getByRole("link", { name: "Check out", exact: true }),
    home: frame.getByRole("link", { name: "Home", exact: true }),
    history: frame.getByRole("link", { name: "History", exact: true }),
  };
}
