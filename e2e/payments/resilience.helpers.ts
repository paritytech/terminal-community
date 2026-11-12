/// <reference types="node" />
// Helpers for the resilience specs (watcher resume, pre-flight, resubscribe).
import { randomBytes } from "node:crypto";
import { encodeAddress } from "@polkadot/util-crypto";
import type { Page } from "@playwright/test";
import type { T3Host } from "../host/fixture";
import { planck, type StoredSale } from "../host/flows";

/**
 * The merchant address the terminal files its sales under: the product
 * account (index 0) as a generic-Substrate (prefix 42) SS58 address, exactly
 * what `normalizeToAssetHubAddress(account.address)` yields. History and
 * Home only show sales whose merchant matches it.
 */
export async function merchantAddress(host: T3Host): Promise<string> {
  const pub = await host.merchantPublicKey(0);
  return encodeAddress(Uint8Array.from(Buffer.from(pub.slice(2), "hex")), 42);
}

/** A fresh 32-hex payment id, the shape the coins flow uses as saleId. */
export const randomSaleId = () => randomBytes(16).toString("hex");
/** A fresh 64-hex top-up id (no 0x), as stored on a sale. */
export const randomTopUpId = () => randomBytes(32).toString("hex");

/**
 * A coins sale row as `handleCoinsPaid` writes it (app/(shell)/terminal/page.tsx),
 * with Dates serialized to ISO strings the way host storage holds them.
 * Defaults to "confirming": a topUpId and no finalizedAt / revertedAt.
 */
export function coinsSaleRow(
  merchant: string,
  over: Partial<StoredSale> & { id: number; amount: string },
): StoredSale {
  const saleId = over.saleId ?? randomSaleId();
  const now = new Date().toISOString();
  return {
    saleId,
    amountPlanck: planck(over.amount).toString(),
    asset: "CASH",
    assetId: "1337",
    merchantAddress: merchant,
    customerAddress: "anonymous",
    merchantAddressNormalized: merchant,
    customerAddressNormalized: "anonymous",
    transactionHash: saleId,
    blockNumber: 0,
    blockHash: saleId,
    timestamp: now,
    topUpId: randomTopUpId(),
    type: "incoming",
    syncStatus: "pending",
    createdAt: now,
    ...over,
  };
}

/** Collect the product frame's console lines (page 'console' sees iframe logs too). */
export function captureConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (m) => lines.push(m.text()));
  return lines;
}

/**
 * Live status subscribers the host holds for `idHex`. The host page exposes
 * this on window.__T3_HOST__, but T3Host has no wrapper for it yet.
 */
export function topUpSubscriberCount(host: T3Host, idHex: string): Promise<number> {
  return host.page.evaluate(
    (id) => (window as unknown as { __T3_HOST__: { topUpSubscriberCount: (i: string) => number } }).__T3_HOST__.topUpSubscriberCount(id),
    idHex,
  );
}
