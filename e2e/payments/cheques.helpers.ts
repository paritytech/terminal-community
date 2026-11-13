/// <reference types="node" />
// Helpers for the cheque-filter and cancel/limits specs.
import { expect, type Frame, type FrameLocator } from "@playwright/test";
import { x25519 } from "@noble/curves/ed25519.js";
import type { T3Host } from "../host/fixture";

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
