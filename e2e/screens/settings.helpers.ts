/// <reference types="node" />
// Helpers for the settings group (merchant-and-settings, reports, voucher):
// URL-only routes, host-storage settings rows, seeded sales, the bytes the
// host received as preimages and a scan of all host storage.
import { expect, type FrameLocator } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { AccountId } from "polkadot-api";
import type { T3Host } from "../host/fixture";
import { planck } from "../host/flows";

const PRODUCT_URL = process.env.E2E_PRODUCT_URL ?? "http://localhost:5199";

/** The path the product document is showing, e.g. "/settings". */
export function productPath(host: T3Host): string {
  const f = host.page.frames().find((fr) => fr !== host.page.mainFrame() && fr.url().startsWith(PRODUCT_URL));
  // next.config has trailingSlash: "/settings" is served as "/settings/".
  return f ? new URL(f.url()).pathname.replace(/(.)\/$/, "$1") : "";
}

/**
 * Restart the product on `path` (host state survives, as on a phone), wait for
 * it to ask for its account again and for the document to stop reloading.
 */
export async function restartOn(host: T3Host, path: string): Promise<FrameLocator> {
  const since = host.mark();
  await host.restartProduct(path);
  await host.next("productLoad", undefined, { since, timeout: 60_000 });
  await host.next("accountGet", undefined, { since, timeout: 90_000 });
  await expect.poll(() => productPath(host), { timeout: 60_000 }).toBe(path);
  await host.settle();
  return host.productFrame();
}

// ── settings table (host storage key "settings": [{id,key,value,updatedAt}]) ──
interface SettingRow { id?: number; key: string; value: string; updatedAt?: string }

export async function settingsRows(host: T3Host): Promise<SettingRow[]> {
  const raw = await host.getStorage<SettingRow[]>("settings");
  return Array.isArray(raw) ? raw : [];
}

/** The stored value of one setting, or undefined. */
export async function setting(host: T3Host, key: string): Promise<string | undefined> {
  return (await settingsRows(host)).find((r) => r.key === key)?.value;
}

/** Wait until the terminal has minted its id (its boot-time settings write). */
export async function waitForBootWrites(host: T3Host): Promise<void> {
  await expect.poll(() => setting(host, "terminal/id"), { timeout: 30_000 }).toMatch(/^[A-Z2-9]{4}$/);
}

export const MERCHANT_PROFILE = {
  fullName: "Ana Petrovic",
  homeAddress: "Knez Mihailova 1",
  phone: "+381 60 000 0000",
  extra: "",
  businessName: "Kiosk Nova",
  businessAddress: "Trg Republike 5",
  taxId: "RS-100200300",
};

/**
 * Host storage of an onboarded merchant, as /merchant's Finish leaves it —
 * for `test.use({ hostOptions: { storage: onboardedMerchantStorage() } })`,
 * so the product boots already onboarded.
 */
export function onboardedMerchantStorage(): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    settings: [
      { id: 1, key: "merchant-profile", value: JSON.stringify({ ...MERCHANT_PROFILE, completedAt: at }), updatedAt: at },
    ],
  };
}

// ── sales ────────────────────────────────────────────────────────────────

/** The merchant's SS58 (prefix 42) address, as the app stores it on a sale. */
export async function merchantAddress(host: T3Host): Promise<string> {
  const pk = await host.merchantPublicKey(0);
  return AccountId(42).dec(Uint8Array.from(Buffer.from(pk.slice(2), "hex")));
}

/** YYYY-MM-DD in local time, as use-current-period.ts computes "today". */
export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface SeededSale { saleId: string; amount: string; amountPlanck: string; timestamp: string }

/**
 * Append finalized coins sales (timestamps a second apart, the last one a
 * second before `endAt`), in the shape terminal/page.tsx writes. Defaults to
 * "just now", i.e. today.
 */
export async function seedSales(host: T3Host, amounts: string[], endAt = new Date()): Promise<SeededSale[]> {
  const merchant = await merchantAddress(host);
  const existing = ((await host.getStorage<Array<{ id?: number }>>("sales")) ?? []) as Array<Record<string, unknown>>;
  let id = existing.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
  const end = endAt.getTime();
  const rows = amounts.map((amount, i) => {
    const at = new Date(end - (amounts.length - i) * 1000).toISOString();
    const saleId = randomBytes(16).toString("hex");
    return {
      id: ++id,
      saleId,
      amount,
      amountPlanck: planck(amount).toString(),
      asset: "CASH",
      assetId: "",
      merchantAddress: merchant,
      merchantAddressNormalized: merchant,
      customerAddress: "anonymous",
      blockNumber: 0,
      timestamp: at,
      createdAt: at,
      finalizedAt: at,
      syncStatus: "synced",
      type: "incoming",
    };
  });
  await host.seedStorage("sales", [...existing, ...rows]);
  return rows.map(({ saleId, amount, amountPlanck, timestamp }) => ({ saleId, amount, amountPlanck, timestamp }));
}

/** Today's sales, ending now. */
export const seedTodaysSales = (host: T3Host, amounts: string[]) => seedSales(host, amounts);

// ── preimages ────────────────────────────────────────────────────────────

/** The bytes the host stored under preimage `key`, as UTF-8 text. */
export async function preimageText(host: T3Host, key: string): Promise<string> {
  const hex = await host.getPreimage(key as `0x${string}`);
  if (!hex) throw new Error(`the host holds no preimage ${key}`);
  return Buffer.from(hex.slice(2), "hex").toString("utf8");
}

// ── whole host storage ───────────────────────────────────────────────────

/** Every host storage key whose name or stored JSON contains `needle`. */
export async function hostStorageHits(host: T3Host, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const key of await host.storageKeys()) {
    const value = await host.getStorage<unknown>(key);
    if (key.includes(needle) || JSON.stringify(value ?? null).includes(needle)) hits.push(key);
  }
  return hits;
}

// ── report encryption key (lib/crypto/manual-key.ts) ──────────────────────

/** The fingerprint Settings → Report Encryption shows for `passphrase`. */
export function keyFingerprint(passphrase: string): string {
  const key = createHash("sha256").update(`t3rminal-manual-key:${passphrase.trim()}`).digest();
  return createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase();
}
