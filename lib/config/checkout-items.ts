/**
 * Manual items catalog for the checkout Items mode.
 *
 * Settings → Show Items in Checkout flips the terminal's entry screen from
 * the bare keypad to an item grid (the keypad stays one tab away as
 * "Amount"), and holds the item list the merchant maintains by hand. Prices
 * are entered incl. tax; unit and tax rate ride along for future receipt and
 * report breakdowns but don't change the charged amount. Back Office sync
 * will feed this catalog in the multi-terminal upgrade — until then it's
 * device-local like the rest of Settings.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { getSetting, setSetting } from "@/lib/storage/database";
import { onStorageChange } from "@/lib/storage/host-storage";

export interface CheckoutItem {
  id: string;
  name: string;
  /** Decimal price incl. tax, normalized to two decimals ("12.00"). */
  price: string;
  unit: string;
  /** Informational VAT percentage — the price above already includes it. */
  taxRate: number;
}

export const CHECKOUT_ITEMS_ENABLED_KEY = "checkout-items/enabled";
export const CHECKOUT_ITEMS_LIST_KEY = "checkout-items/list";

export const ITEM_UNITS = ["Each", "Hour", "kg", "Liter"] as const;
export const TAX_RATES = [0, 5, 10, 20, 23, 25] as const;
export const DEFAULT_UNIT = "Each";
export const DEFAULT_TAX_RATE = 23;

/**
 * Validate + normalize a price the merchant typed ("12", "12,5", "12.50").
 * Returns the canonical two-decimal string, or null when it isn't a positive
 * amount with at most two decimals.
 */
export function normalizePriceInput(raw: string): string | null {
  const cleaned = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  if (cents <= 0n) return null;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Parse the stored JSON list, dropping anything that doesn't look like an item. */
export function parseCheckoutItems(raw: string | undefined): CheckoutItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CheckoutItem =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as CheckoutItem).id === "string" &&
        typeof (entry as CheckoutItem).name === "string" &&
        typeof (entry as CheckoutItem).price === "string" &&
        normalizePriceInput((entry as CheckoutItem).price) !== null &&
        typeof (entry as CheckoutItem).unit === "string" &&
        typeof (entry as CheckoutItem).taxRate === "number",
    );
  } catch {
    return [];
  }
}

export function newCheckoutItemId(): string {
  return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getCheckoutItemsEnabled(): Promise<boolean> {
  return (await getSetting(CHECKOUT_ITEMS_ENABLED_KEY)) === "1";
}

export async function setCheckoutItemsEnabled(on: boolean): Promise<void> {
  await setSetting(CHECKOUT_ITEMS_ENABLED_KEY, on ? "1" : "0");
}

export async function getCheckoutItems(): Promise<CheckoutItem[]> {
  return parseCheckoutItems(await getSetting(CHECKOUT_ITEMS_LIST_KEY));
}

async function writeCheckoutItems(items: CheckoutItem[]): Promise<void> {
  await setSetting(CHECKOUT_ITEMS_LIST_KEY, JSON.stringify(items));
}

/** Insert or replace (by id) a single item. */
export async function upsertCheckoutItem(item: CheckoutItem): Promise<void> {
  const items = await getCheckoutItems();
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) items.push(item);
  else items[idx] = item;
  await writeCheckoutItems(items);
}

export async function deleteCheckoutItem(id: string): Promise<void> {
  const items = await getCheckoutItems();
  await writeCheckoutItems(items.filter((i) => i.id !== id));
}

/**
 * Reactive view over the toggle + item list; refreshes whenever the settings
 * table changes from any page. `enabled` is undefined until the first read
 * resolves so callers can avoid flashing the wrong checkout screen.
 */
export function useCheckoutItems(): {
  enabled: boolean | undefined;
  items: CheckoutItem[];
  isLoading: boolean;
  setEnabled: (on: boolean) => Promise<void>;
} {
  const [enabled, setEnabledState] = useState<boolean | undefined>(undefined);
  const [items, setItems] = useState<CheckoutItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([getCheckoutItemsEnabled(), getCheckoutItems()]).then(
        ([on, list]) => {
          if (!alive) return;
          setEnabledState(on);
          setItems(list);
          setIsLoading(false);
        },
        (err) => {
          // Settings unreadable: the storage banner says why. Show the plain
          // keypad rather than loading forever; a recovery refetches.
          console.warn("[CheckoutItems] settings unreadable:", err);
          if (!alive) return;
          setEnabledState((prev) => prev ?? false);
          setIsLoading(false);
        },
      );
    };
    refresh();
    const off = onStorageChange("settings", refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    setEnabledState(on);
    await setCheckoutItemsEnabled(on);
  }, []);

  return { enabled, items, isLoading, setEnabled };
}
