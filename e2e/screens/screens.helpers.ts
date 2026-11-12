/// <reference types="node" />
// Helpers for the screen specs (e2e/screens/*): seeded sales, in-frame
// navigation, and the product frame's current path.
import { expect, type Frame } from "@playwright/test";
import { AccountId } from "polkadot-api";
import type { T3Host } from "../host/fixture";
import { planck } from "../host/flows";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

/** The live product document (not a FrameLocator — for url() and evaluate). */
export function productFrameHandle(host: T3Host): Frame | undefined {
  return host.page.frames().find((f) => f !== host.page.mainFrame() && f.url().startsWith(PRODUCT_URL));
}

/** Path the product frame is showing, e.g. "/terminal". */
export function productPath(host: T3Host): string {
  const f = productFrameHandle(host);
  // next.config has trailingSlash: "/terminal/" → "/terminal"
  return f ? new URL(f.url()).pathname.replace(/(.)\/+$/, "$1") : "";
}

/**
 * Change the product's location from inside the frame (as a URL-only route is
 * reached), then wait until the document stops reloading.
 */
export async function gotoInFrame(host: T3Host, path: string): Promise<void> {
  await host.productFrame().locator("body").evaluate((_, p) => { window.location.href = p; }, path);
  await expect.poll(() => productPath(host)).toBe(path);
  await host.settle();
}

/** The merchant's SS58 (prefix 42) address, as the app stores it on a sale. */
export async function merchantAddress(host: T3Host): Promise<string> {
  const pk = await host.merchantPublicKey(0);
  return AccountId(42).dec(Uint8Array.from(Buffer.from(pk.slice(2), "hex")));
}

/** Alice — some other merchant whose sales must never show up here. */
export const OTHER_MERCHANT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/** Local noon `daysAgo` days back — clear of midnight and DST edges. */
export function noonDaysAgo(daysAgo: number, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
}

export type SeedState = "received" | "confirming" | "partial" | "reverted";

export interface SeedSale {
  /** 4 hex chars; the sale id ends with these. Use a "0" so it can never match a base58 address. */
  last4: string;
  amount: string; // what was credited
  state: SeedState;
  at: Date;
  requested?: string; // partial only
  merchant?: string; // defaults to the connected merchant
  items?: Array<{ name: string; quantity: number; unitPrice: string }>;
  tip?: string;
  note?: string;
}

/** Sale id: 28 fixed hex chars + the 4-char suffix. */
export const saleIdFor = (last4: string) => "f".repeat(28) + last4;
/** A topUpId that the host has never heard of (bare hex, as the app stores it). */
export const topUpIdFor = (last4: string) => "ab".repeat(30) + last4;

/** Build sale rows in exactly the shape terminal/page.tsx writes for a coins sale. */
export function buildSales(merchant: string, seeds: SeedSale[]) {
  return seeds.map((s, i) => {
    const saleId = saleIdFor(s.last4);
    const addr = s.merchant ?? merchant;
    const ts = s.at.toISOString();
    return {
      id: i + 1,
      saleId,
      amount: s.amount,
      amountPlanck: planck(s.amount).toString(),
      asset: "CASH",
      assetId: "",
      merchantAddress: addr,
      customerAddress: "anonymous",
      merchantAddressNormalized: addr,
      customerAddressNormalized: "anonymous",
      transactionHash: saleId,
      blockNumber: 0,
      blockHash: saleId,
      timestamp: ts,
      createdAt: ts,
      syncStatus: "pending",
      type: "incoming",
      topUpId: topUpIdFor(s.last4),
      ...(s.state === "received" || s.state === "partial" || s.state === "reverted" ? { finalizedAt: ts } : {}),
      ...(s.state === "reverted" ? { revertedAt: ts } : {}),
      ...(s.state === "partial"
        ? { requestedAmount: s.requested!, requestedAmountPlanck: planck(s.requested!).toString() }
        : {}),
      ...(s.items ? { items: s.items } : {}),
      ...(s.tip ? { tip: s.tip } : {}),
      ...(s.note ? { note: s.note } : {}),
    };
  });
}

/**
 * Seed host storage 'sales' for the connected merchant and (re)start the
 * product on `path`, so every screen reads the seed on first render.
 */
export async function seedSalesAndOpen(host: T3Host, seeds: SeedSale[], path: string) {
  const merchant = await merchantAddress(host);
  const rows = buildSales(merchant, seeds);
  await host.seedStorage("sales", rows);
  await host.restartProduct(path);
  await expect.poll(() => productPath(host), { timeout: 30_000 }).toBe(path);
  await host.settle();
  return { merchant, rows };
}
