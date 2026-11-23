"use client";

/**
 * Paid sales the host's storage refused to keep.
 *
 * The money has arrived; only the record is missing. A sale the host would
 * not store is kept here — in memory and, best effort, in sessionStorage, so
 * Done, a tab change or a reload in the same webview does not lose it — and
 * saved as soon as the storage takes writes again: on the merchant's "Save
 * again" or "Check again", or by itself when the storage recovers. Its
 * pending claim (./pending-claims.ts), when that could be written, also
 * brings it back on the next launch; the sale is stored once either way
 * (addSaleRecord keeps one row per saleId).
 */

import { useSyncExternalStore } from "react";
import { addSaleRecord } from "@/lib/storage/database";
import { getSaleStorageHealth, onStorageHealth } from "@/lib/storage/host-storage";
import type { SaleRecord } from "@/lib/storage/types";
import { dropPendingClaim } from "./pending-claims";
import { watchTopUpFinality } from "./topup-watcher";

export interface UnsavedSale {
  record: Omit<SaleRecord, "id" | "createdAt" | "syncStatus">;
  paymentId: string;
  /** The claim's registration, for the finality watcher once saved. */
  topUpIdHex: string;
  finalized: boolean;
}

const SESSION_KEY = "t3rminal:unsaved-sales";
const queue = new Map<string, UnsavedSale>();
const events = new EventTarget();
// A stable snapshot for React, replaced on every change.
let snapshot: UnsavedSale[] = [];
const EMPTY: UnsavedSale[] = [];

function persist(): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (queue.size === 0) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify([...queue.values()]));
  } catch {
    // Best effort: memory still holds it.
  }
}

function restore(): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    for (const sale of JSON.parse(raw) as UnsavedSale[]) {
      if (sale?.paymentId && sale.record) queue.set(sale.paymentId, sale);
    }
    snapshot = [...queue.values()];
  } catch {
    // Unreadable: nothing to restore.
  }
}

function changed(): void {
  snapshot = [...queue.values()];
  persist();
  events.dispatchEvent(new Event("change"));
}

/** Keep a paid sale the storage refused, until it can be saved. */
export function keepUnsavedSale(sale: UnsavedSale): void {
  queue.set(sale.paymentId, sale);
  changed();
}

export function getUnsavedSales(): UnsavedSale[] {
  return snapshot;
}

export function onUnsavedSales(callback: () => void): () => void {
  events.addEventListener("change", callback);
  return () => events.removeEventListener("change", callback);
}

let saving: Promise<number> | null = null;
// Asked for again while a run was going: run once more after it.
let again = false;

async function saveAll(): Promise<number> {
  // Re-read the queue each round: a sale kept meanwhile is tried too.
  for (;;) {
    const sale = queue.values().next().value as UnsavedSale | undefined;
    if (!sale) return 0;
    try {
      await addSaleRecord({ ...sale.record, syncStatus: "pending" });
    } catch (err) {
      console.warn("[UnsavedSales] still can't save:", err);
      return queue.size;
    }
    queue.delete(sale.paymentId);
    changed();
    if (!sale.finalized) watchTopUpFinality({ saleId: sale.paymentId, topUpIdHex: sale.topUpIdHex });
    await dropPendingClaim(sale.paymentId).catch(() => {
      // The sale is kept; a stale pending claim is dropped on the next launch.
    });
  }
}

/**
 * Save every kept sale, oldest first, stopping at the first the storage
 * refuses. One run at a time; a call during a run gets one more run after
 * it. Resolves to how many are still unsaved.
 */
export function saveUnsavedSales(): Promise<number> {
  if (saving) {
    again = true;
    return saving;
  }
  if (queue.size === 0) return Promise.resolve(0);
  const run = (async () => {
    let left = await saveAll();
    while (again && left > 0) {
      again = false;
      left = await saveAll();
    }
    again = false;
    return left;
  })();
  saving = run;
  void run.finally(() => {
    if (saving === run) saving = null;
  });
  return run;
}

/** The kept sales, live. */
export function useUnsavedSales(): UnsavedSale[] {
  return useSyncExternalStore(onUnsavedSales, getUnsavedSales, () => EMPTY);
}

if (typeof window !== "undefined") {
  restore();
  // Save them by themselves as soon as a sale can be kept again…
  onStorageHealth(() => {
    if (getSaleStorageHealth().ok && queue.size > 0) void saveUnsavedSales();
  });
  // …and, for sales kept before a reload, once this document's storage is up.
  if (queue.size > 0) setTimeout(() => void saveUnsavedSales(), 0);
}
