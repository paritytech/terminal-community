/// <reference types="node" />
// Helpers for the resilience specs (watcher resume, pre-flight, resubscribe).
import { randomBytes } from "node:crypto";
import { encodeAddress } from "@polkadot/util-crypto";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import type { Page } from "@playwright/test";
import { devRoot, getPublicKey, productSecret } from "../host/keys";
import { planck, type StoredSale } from "../host/flows";
import type { HostConfig } from "../host/protocol";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

/**
 * RFC-0022 plain index → 32-byte derivation index: the u32 little-endian
 * followed by blake2b256("product-account-index")[..28]. Same bytes as
 * host-container's `indexBytes`, which the host page derives with.
 */
function indexBytes(index: number): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, index, true);
  out.set(blake2b256(new TextEncoder().encode("product-account-index")).slice(0, 28), 4);
  return out;
}

/**
 * The merchant address the terminal files its sales under, computed in Node
 * so it can go into `hostOptions.storage` before the host boots: the product
 * account (index 0 under `root`) as a generic-Substrate (prefix 42) SS58
 * address, which is what `normalizeToAssetHubAddress(account.address)` yields.
 * History and Home only show sales whose merchant matches it.
 */
export function merchantAddressFor(root: HostConfig["root"] = "Bob", index = 0): string {
  const productId = new URL(PRODUCT_URL).host;
  const pub = getPublicKey(productSecret(devRoot(root), productId, indexBytes(index)));
  return encodeAddress(pub, 42);
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
