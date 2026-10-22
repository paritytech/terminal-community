/**
 * Items catalog storage (categories + items).
 *
 * Persisted via host-storage (Polkadot Desktop hostLocalStorage when available,
 * in-memory fallback otherwise). Two underlying tables:
 *   - `item-categories` → ItemCategory[]
 *   - `item-catalog`    → CatalogItem[]
 *
 * The catalog starts empty. It only gets populated once the merchant scans an
 * admin config QR (see `overwriteCatalogFromQr`) — until then both the local
 * tables and the derived menu are blank.
 */

"use client"

import { readTable, writeTable, onStorageChange } from "@/lib/storage/host-storage"
import type { QrItemConfig, T3rminalConfigQrPayloadV2 } from "@/lib/config/t3rminal-config-qr"
import { loadAdminQrPayload } from "@/lib/config/admin-qr-binding"
import type { Catalog, CatalogItem, ItemCategory } from "./types"

const SETTINGS_TABLE = "settings"

const CATEGORIES_TABLE = "item-categories"
const ITEMS_TABLE = "item-catalog"

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Fallback for SSR or older environments
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function loadCatalog(): Promise<Catalog> {
  // The catalog is entirely admin-QR driven. When a config QR is bound, that
  // payload IS the catalog — derived directly from it so the menu always
  // mirrors the admin config (no copy step, no drift). When nothing is bound
  // the catalog is empty; there is no manual editing path anymore.
  const adminPayload = await loadAdminQrPayload()
  if (adminPayload) return catalogFromAdminPayload(adminPayload)

  // Wipe any locally-seeded categories/items left over from older builds so
  // the predefined Drinks/Food examples don't resurface on existing installs.
  await clearLegacyLocalCatalog()
  return { categories: [], items: [] }
}

/**
 * One-shot cleanup of legacy on-device catalog tables. Older builds seeded a
 * Drinks/Food example menu (and allowed manual edits) into these tables; both
 * paths are gone, so any leftover rows are stale and get cleared. Idempotent —
 * once the tables are empty it stops writing.
 */
async function clearLegacyLocalCatalog(): Promise<void> {
  const [categories, items] = await Promise.all([
    readTable<ItemCategory>(CATEGORIES_TABLE),
    readTable<CatalogItem>(ITEMS_TABLE),
  ])
  if (categories.length === 0 && items.length === 0) return
  await Promise.all([
    writeTable(CATEGORIES_TABLE, []),
    writeTable(ITEMS_TABLE, []),
  ])
}

function catalogFromAdminPayload(payload: T3rminalConfigQrPayloadV2): Catalog {
  // Stable derived IDs keyed off the admin's own ids — that way React keys
  // stay stable across rescans where the same item is unchanged.
  const category: ItemCategory = {
    id: `admin:${payload.config.id}`,
    name: payload.config.name,
  }
  const items: CatalogItem[] = payload.config.items.map((item) => ({
    id: `admin:${item.id}`,
    categoryId: category.id,
    name: item.name,
    pricePlanks: item.pricePlancks,
  }))
  return { categories: [category], items }
}

// ── Reactivity helper ─────────────────────────────────────────

/**
 * Subscribe to any catalog change (categories or items table). Returns an
 * unsubscribe function.
 */
export function onCatalogChange(callback: () => void): () => void {
  const offCategories = onStorageChange(CATEGORIES_TABLE, callback)
  const offItems = onStorageChange(ITEMS_TABLE, callback)
  // Admin payload lives in the settings table — listen for its
  // writes/clears so scanning (or clearing) flips /items into admin
  // mode (or back to local mode) without a manual refresh.
  const offSettings = onStorageChange(SETTINGS_TABLE, callback)
  return () => {
    offCategories()
    offItems()
    offSettings()
  }
}

// ── Admin QR import ────────────────────────────────────────────

/**
 * Replace the on-device catalog with the item set carried by a scanned
 * admin QR. The shared QR contract has no notion of categories — t3rminal
 * surfaces items grouped by category, so we synthesize a single category
 * named after the config and bind every imported item to it.
 *
 * Existing categories/items are overwritten (not merged) so a rescan
 * cleanly replaces the previous binding.
 */
export async function overwriteCatalogFromQr(config: QrItemConfig): Promise<Catalog> {
  const category: ItemCategory = { id: newId(), name: config.name }
  const items: CatalogItem[] = config.items.map((item) => ({
    id: newId(),
    categoryId: category.id,
    name: item.name,
    pricePlanks: item.pricePlancks,
  }))
  await Promise.all([
    writeTable(CATEGORIES_TABLE, [category]),
    writeTable(ITEMS_TABLE, items),
  ])
  return { categories: [category], items }
}

/**
 * Pure mapper, no I/O. Exposed so callers can preview the resulting
 * catalog (e.g. a "scanned X items" confirmation) before committing.
 */
export function mapQrConfigToCatalog(config: QrItemConfig): Catalog {
  const category: ItemCategory = { id: newId(), name: config.name }
  const items: CatalogItem[] = config.items.map((item) => ({
    id: newId(),
    categoryId: category.id,
    name: item.name,
    pricePlanks: item.pricePlancks,
  }))
  return { categories: [category], items }
}
