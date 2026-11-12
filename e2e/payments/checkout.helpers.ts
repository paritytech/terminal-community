/// <reference types="node" />
// Helpers for the checkout specs: items mode on /terminal, the legacy
// /items -> /tips -> /terminal path, and the receipt screens after a sale.
import { readFileSync } from "node:fs";
import { expect, type Frame, type FrameLocator, type Locator } from "@playwright/test";
import type { T3Host } from "../host/fixture";
import { bootTerminal, topicHex } from "../host/flows";
import type { ChequeRequest } from "../host/payer";
import type { TopUpRecord } from "../host/protocol";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

/** The asset symbol every amount on screen carries. */
export const SYM = "CASH";

/** The live product document (a Frame, for url() and evaluate()). */
export function productFrameHandle(host: T3Host): Frame {
  const f = host.page.frames().find((fr) => fr !== host.page.mainFrame() && fr.url().startsWith(PRODUCT_URL));
  if (!f) throw new Error("no product frame");
  return f;
}

/** Path the product frame is showing, e.g. "/terminal". */
export function productPath(host: T3Host): string {
  try {
    return new URL(productFrameHandle(host).url()).pathname;
  } catch {
    return "";
  }
}

// ── settings table (host storage key "settings") ──────────────────────────
interface SettingRow { id: number; key: string; value: string; updatedAt: string }

export async function settingsRows(host: T3Host): Promise<SettingRow[]> {
  const raw = await host.getStorage<SettingRow[]>("settings");
  return Array.isArray(raw) ? raw : [];
}

export async function settingValue(host: T3Host, key: string): Promise<string | undefined> {
  return (await settingsRows(host)).find((r) => r.key === key)?.value;
}

/** Upsert rows into the app's settings table, the shape setSetting writes. */
export async function seedSettings(host: T3Host, entries: Record<string, string>): Promise<void> {
  const rows = await settingsRows(host);
  let id = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
  for (const [key, value] of Object.entries(entries)) {
    const at = rows.findIndex((r) => r.key === key);
    const row = { key, value, updatedAt: new Date().toISOString() };
    if (at >= 0) rows[at] = { ...rows[at], ...row };
    else rows.push({ id: ++id, ...row });
  }
  await host.seedStorage("settings", rows);
}

// ── items mode ────────────────────────────────────────────────────────────
export interface CatalogItem { id: string; name: string; price: string; unit: string; taxRate: number }

export const CATALOG: CatalogItem[] = [
  { id: "ci-espresso", name: "Espresso", price: "2.50", unit: "Each", taxRate: 23 },
  { id: "ci-croissant", name: "Croissant", price: "3.20", unit: "Each", taxRate: 10 },
];

/**
 * Boot the terminal, switch Items mode on with `items` in the catalog (the
 * settings Settings > Show Items in Checkout writes), restart the product and
 * wait for the item grid with the pre-flight probe running.
 */
export async function bootItemsCheckout(host: T3Host, items: CatalogItem[] = CATALOG): Promise<FrameLocator> {
  // First boot settles the app's own boot-time writes, so the seed below
  // cannot be overwritten by a read-modify-write that started before it.
  await bootTerminal(host);
  await seedSettings(host, {
    "checkout-items/enabled": "1",
    "checkout-items/list": JSON.stringify(items),
  });
  const since = host.mark();
  await host.restartProduct("/terminal");
  await host.next("productLoad", undefined, { since, timeout: 60_000 });
  const frame = host.productFrame();
  await expect(frame.getByTestId("items-charge")).toBeVisible({ timeout: 60_000 });
  await host.settle();
  // The coins pre-flight is armed once the payment method has loaded.
  await host.next("balanceSubscribe", undefined, { since, timeout: 60_000 });
  return frame;
}

/** An item tile on the grid (a button whose text holds the name and price). */
export function tile(frame: FrameLocator, name: string): Locator {
  return frame.locator("main").getByRole("button").filter({ hasText: name });
}

/** The count badge on the basket button (no badge = empty basket). */
export function cartBadge(frame: FrameLocator): Locator {
  return frame.getByTestId("cart-button").locator("span");
}

/** Press the basket's Charge and wait for the cheque QR for `total`. */
export async function chargeBasket(host: T3Host, frame: FrameLocator, total: string): Promise<ChequeRequest> {
  const since = host.mark();
  const button = frame.getByTestId("items-charge");
  await expect(button).toHaveText(`Charge ${total} ${SYM}`);
  await button.click();
  await expect(frame.getByTestId("waiting-text")).toHaveText("Scan QR to pay", { timeout: 30_000 });
  const req = await host.readChequeRequest();
  expect(req.amount).toBe(total);
  await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since, timeout: 15_000 });
  return req;
}

/** Pay the cheque on screen and wait for the completed screen. */
export async function payAndComplete(host: T3Host, frame: FrameLocator, req: ChequeRequest): Promise<TopUpRecord> {
  const since = host.mark();
  await host.pay({ req });
  const topUp = await host.waitForTopUp({ since, timeout: 30_000 });
  expect(topUp.answer).toBe("accept");
  await expect(frame.getByTestId("payment-completed")).toHaveText("Payment received", { timeout: 30_000 });
  return topUp;
}

// ── legacy /items handoff ────────────────────────────────────────────────
export interface PendingLine { name: string; pricePlanks: string; quantity: number }

/**
 * Write the cart handoff that /items "Charge" leaves in sessionStorage
 * ("t3rminal:pending-sale") for /terminal to read.
 */
export async function stashPendingSale(host: T3Host, lines: PendingLine[]): Promise<bigint> {
  const total = lines.reduce((s, l) => s + BigInt(l.pricePlanks) * BigInt(l.quantity), 0n);
  await productFrameHandle(host).evaluate(
    ([data]) => sessionStorage.setItem("t3rminal:pending-sale", data),
    [JSON.stringify({ lines, totalPlanks: total.toString(), createdAt: Date.now() })] as const,
  );
  return total;
}

export async function readPendingSale(host: T3Host): Promise<string | null> {
  return productFrameHandle(host).evaluate(() => sessionStorage.getItem("t3rminal:pending-sale"));
}

/** Load `path` in the product frame (a URL-only route) and wait for it to settle. */
export async function openRoute(host: T3Host, path: string): Promise<void> {
  const since = host.mark();
  await host.restartProduct(path);
  await host.next("productLoad", undefined, { since, timeout: 60_000 });
  await host.settle();
}

// ── QR decoding (zxing-wasm in Node, as a phone camera would) ────────────
let zxingReady: Promise<typeof import("zxing-wasm/reader")> | null = null;
export async function decodeQrIn(locator: Locator): Promise<string> {
  zxingReady ??= (async () => {
    const z = await import("zxing-wasm/reader");
    const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    await z.prepareZXingModule({
      overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    return z;
  })();
  const png = await locator.screenshot();
  const [hit] = await (await zxingReady).readBarcodes(new Uint8Array(png), { formats: ["QRCode"] });
  if (!hit?.text) throw new Error("no QR in locator");
  return hit.text;
}
