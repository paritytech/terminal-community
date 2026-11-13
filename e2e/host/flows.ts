/// <reference types="node" />
// Shared steps for specs on the Terminal test host: boot, keypad, charge, pay.
import { expect, type FrameLocator } from "@playwright/test";
import type { T3Host } from "./fixture";
import type { Hex } from "./protocol";
import { randomCoins, topicFor, topUpIdFor, type ChequeRequest } from "./payer";

export const hexOf = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
export const topicHex = (id: string) => hexOf(topicFor(id));
export const topUpIdHex = (id: string, attempt = 1) => hexOf(topUpIdFor(id, attempt));
/** CASH has 6 decimals: "12.50" → 12_500_000n. */
export const planck = (amount: string) => BigInt(Math.round(parseFloat(amount) * 100)) * 10_000n;

/**
 * Wait until the app has its account and shows the keypad, and the product
 * document has stopped reloading.
 */
export async function bootTerminal(host: T3Host, timeout = 90_000): Promise<FrameLocator> {
  await host.next("accountGet", undefined, { timeout });
  const frame = host.productFrame();
  await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible({ timeout });
  await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout });
  await host.settle();
  // The coins pre-flight subscribes to the balance once the page is up; a
  // Charge before that skips straight to the probe, which is fine, but specs
  // read more clearly when the terminal is fully idle first.
  await host.next("balanceSubscribe", undefined, { timeout });
  return frame;
}

/** Type a decimal amount on the cents keypad: "12.50" → 1, 2, 5, 0. */
export async function enterAmount(frame: FrameLocator, amount: string): Promise<void> {
  const cents = Math.round(parseFloat(amount) * 100).toString();
  for (const digit of cents) await frame.locator(`[data-testid="calc-digit-${digit}"]`).click();
  await expect(frame.locator('[data-testid="amount-display"]')).toContainText(Number(amount).toFixed(2));
}

/**
 * Enter `amount`, press Charge and wait for the cheque QR. Returns the request
 * the terminal is showing, after checking it subscribed to that request's
 * topic.
 */
export async function charge(host: T3Host, frame: FrameLocator, amount: string): Promise<ChequeRequest> {
  const since = host.mark();
  await enterAmount(frame, amount);
  await frame.locator('[data-testid="btn-charge"]').click();
  await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay", { timeout: 30_000 });
  const req = await host.readChequeRequest();
  expect(req.amount).toBe(Number(amount).toFixed(2));
  await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since, timeout: 15_000 });
  return req;
}

/** Charge `amount` and pay it with `coins` fresh coins. */
export async function chargeAndPay(host: T3Host, frame: FrameLocator, amount: string, coins = 2) {
  const req = await charge(host, frame, amount);
  const since = host.mark();
  const sent = randomCoins(coins);
  const { buildCheque } = await import("./payer");
  const { topic, data } = buildCheque(req, sent);
  await host.injectStatement(topic, data);
  const topUp = await host.waitForTopUp({ since, timeout: 30_000 });
  return { req, coins: sent, topUp };
}

/** The sale rows the app has written to host storage. */
export interface StoredSale {
  saleId: string;
  amount: string;
  amountPlanck?: string;
  requestedAmount?: string;
  customerAddress?: string;
  blockNumber?: number;
  topUpId?: string;
  finalizedAt?: string | number;
  revertedAt?: string | number;
  note?: string;
  items?: unknown[];
  tip?: unknown;
  [key: string]: unknown;
}

export async function storedSales(host: T3Host): Promise<StoredSale[]> {
  const raw = await host.getStorage<unknown>("sales");
  if (Array.isArray(raw)) return raw as StoredSale[];
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, StoredSale>);
  return [];
}

/** Poll host storage until `pick` finds the sale and `until` holds for it. */
export async function waitForSale(
  host: T3Host,
  saleId: string,
  until: (sale: StoredSale) => boolean = () => true,
  timeout = 30_000,
): Promise<StoredSale> {
  let last: StoredSale | undefined;
  await expect
    .poll(async () => {
      last = (await storedSales(host)).find((s) => s.saleId === saleId);
      return !!last && until(last);
    }, { timeout })
    .toBe(true);
  return last!;
}
