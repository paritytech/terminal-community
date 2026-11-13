/// <reference types="node" />
// Helpers for the checkout specs: items mode on /terminal, the legacy
// /items -> /tips -> /terminal path, and the receipt screens after a sale.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { expect, type Frame, type FrameLocator, type Locator } from "@playwright/test";
import type { T3Host } from "../host/fixture";
import { topicHex } from "../host/flows";
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

/**
 * Settings rows, in the shape setSetting writes, for `hostOptions.storage`:
 * the host has them before the product boots, as if the merchant had saved
 * them in an earlier session.
 */
export function settingsSeed(entries: Record<string, string>): { settings: SettingRow[] } {
  const updatedAt = new Date().toISOString();
  return { settings: Object.entries(entries).map(([key, value], i) => ({ id: i + 1, key, value, updatedAt })) };
}

// ── items mode ────────────────────────────────────────────────────────────
export interface CatalogItem { id: string; name: string; price: string; unit: string; taxRate: number }

export const CATALOG: CatalogItem[] = [
  { id: "ci-espresso", name: "Espresso", price: "2.50", unit: "Each", taxRate: 23 },
  { id: "ci-croissant", name: "Croissant", price: "3.20", unit: "Each", taxRate: 10 },
];

/** Host storage with Items mode on and `items` in the catalog (Settings > Show Items in Checkout). */
export function itemsModeStorage(items: CatalogItem[] = CATALOG): { settings: SettingRow[] } {
  return settingsSeed({ "checkout-items/enabled": "1", "checkout-items/list": JSON.stringify(items) });
}

/**
 * Wait for the item grid of a product that booted with Items mode on (see
 * itemsModeStorage), the document settled and the coins pre-flight armed.
 */
export async function bootItemsCheckout(host: T3Host, timeout = 90_000): Promise<FrameLocator> {
  await host.next("accountGet", undefined, { timeout });
  const frame = host.productFrame();
  await expect(frame.getByTestId("items-charge")).toBeVisible({ timeout });
  await host.settle();
  // The coins pre-flight is armed once the payment method has loaded.
  await host.next("balanceSubscribe", undefined, { timeout });
  return frame;
}

/** The on-screen receipt (the generated SVG, not the HTML fallback). */
export function receiptSvg(frame: FrameLocator): Locator {
  return frame.getByTestId("receipt-svg").locator("svg").first();
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
  const button = frame.getByTestId("items-charge");
  await expect(button).toHaveText(`Charge ${total} ${SYM}`);
  const since = host.mark();
  // The Charge runs its own pre-flight at once (the periodic one is 15 s apart).
  await Promise.all([host.next("balanceSubscribe", undefined, { since, timeout: 1_500 }), button.click()]);
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
async function loadZxing() {
  const z = await import("zxing-wasm/reader");
  const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
  await z.prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
    fireImmediately: true,
  });
  return z;
}
export async function decodeQrIn(locator: Locator): Promise<string> {
  zxingReady ??= loadZxing();
  const png = await locator.screenshot();
  const [hit] = await (await zxingReady).readBarcodes(new Uint8Array(png), { formats: ["QRCode"] });
  if (!hit?.text) throw new Error("no QR in locator");
  return hit.text;
}

/** Decode a QR from raw RGB(A) pixels, e.g. an image lifted out of a PDF. */
export async function decodeQrPixels(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Promise<string> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = pixels[p * channels];
    rgba[p * 4 + 1] = pixels[p * channels + 1];
    rgba[p * 4 + 2] = pixels[p * channels + 2];
    rgba[p * 4 + 3] = 255;
  }
  zxingReady ??= loadZxing();
  const [hit] = await (await zxingReady).readBarcodes({ data: rgba, width, height, colorSpace: "srgb" } as ImageData, { formats: ["QRCode"] });
  if (!hit?.text) throw new Error("no QR in pixels");
  return hit.text;
}

/**
 * The one image XObject of a PDF (jsPDF writes the receipt as a single RGB
 * image), with its pixels inflated when the stream is compressed.
 */
export function pdfImage(pdf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const text = pdf.toString("latin1");
  const dicts = [...text.matchAll(/<<((?:(?!>>)[\s\S])*?\/Subtype \/Image[\s\S]*?)>>\s*stream\r?\n/g)];
  if (dicts.length !== 1) throw new Error(`expected one image in the PDF, found ${dicts.length}`);
  const [whole, dict] = dicts[0];
  const num = (key: string) => Number(new RegExp(`/${key} (\\d+)`).exec(dict)?.[1]);
  if (!/\/ColorSpace \/DeviceRGB/.test(dict) || num("BitsPerComponent") !== 8) throw new Error(`unexpected image: ${dict}`);
  const start = dicts[0].index! + whole.length;
  let pixels: Uint8Array = pdf.subarray(start, start + num("Length"));
  if (/\/Filter \/FlateDecode/.test(dict)) pixels = inflateSync(pixels);
  if (/\/DecodeParms/.test(dict)) throw new Error(`predictor not supported: ${dict}`);
  return { width: num("Width"), height: num("Height"), pixels };
}
