/// <reference types="node" />
// Helpers for the settings group (merchant-and-settings, reports, voucher):
// URL-only routes, host-storage settings rows, seeded sales and the bytes the
// host received as preimages.
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

/**
 * Wait until the terminal has minted its id (its one boot-time settings
 * write), so a seed that follows can not be clobbered by that write.
 */
export async function waitForBootWrites(host: T3Host): Promise<void> {
  await expect.poll(() => setting(host, "terminal/id"), { timeout: 30_000 }).toMatch(/^[A-Z2-9]{4}$/);
}

/** Upsert settings rows straight into host storage (as an earlier session would have left them). */
export async function seedSettings(host: T3Host, entries: Record<string, string>): Promise<void> {
  await waitForBootWrites(host);
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

export const MERCHANT_PROFILE = {
  fullName: "Ana Petrovic",
  homeAddress: "Knez Mihailova 1",
  phone: "+381 60 000 0000",
  extra: "",
  businessName: "Kiosk Nova",
  businessAddress: "Trg Republike 5",
  taxId: "RS-100200300",
};

/** An onboarded merchant, as /merchant's Finish leaves it. */
export async function seedOnboardedMerchant(host: T3Host): Promise<void> {
  await seedSettings(host, {
    "merchant-profile": JSON.stringify({ ...MERCHANT_PROFILE, completedAt: new Date().toISOString() }),
  });
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
 * Append finalized coins sales for today (timestamps a few seconds apart and
 * no later than now), in the shape terminal/page.tsx writes.
 */
export async function seedTodaysSales(host: T3Host, amounts: string[]): Promise<SeededSale[]> {
  const merchant = await merchantAddress(host);
  const existing = ((await host.getStorage<Array<{ id?: number }>>("sales")) ?? []) as Array<Record<string, unknown>>;
  let id = existing.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
  const now = Date.now();
  const rows = amounts.map((amount, i) => {
    const at = new Date(now - (amounts.length - i) * 1000).toISOString();
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

// ── preimages ────────────────────────────────────────────────────────────

/**
 * Record every preimage the host stores, from now on, so a spec can read the
 * bytes the app uploaded. The host's control surface exposes only key + size
 * (getPreimages), so this wraps Map#set on the host page and keeps the values
 * whose key is a 32-byte hex hash and whose value is bytes — only the
 * host's preimage map stores that shape (storage is keyed by table name).
 * Host state never reloads, so one install per test is enough.
 */
export async function capturePreimages(host: T3Host): Promise<void> {
  await host.page.evaluate(() => {
    const w = window as unknown as { __e2ePreimages?: Record<string, string> };
    if (w.__e2ePreimages) return;
    const seen: Record<string, string> = {};
    w.__e2ePreimages = seen;
    const set = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === "string" && /^0x[0-9a-f]{64}$/.test(k) && v instanceof Uint8Array) {
        seen[k] = Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
      }
      return set.call(this, k, v);
    } as typeof Map.prototype.set;
  });
}

/** The bytes of the preimage stored under `key`, as UTF-8 text. */
export async function preimageText(host: T3Host, key: string): Promise<string> {
  const hex = await host.page.evaluate(
    (k) => (window as unknown as { __e2ePreimages?: Record<string, string> }).__e2ePreimages?.[k],
    key,
  );
  if (!hex) throw new Error(`no captured preimage for ${key} (call capturePreimages first)`);
  return Buffer.from(hex, "hex").toString("utf8");
}

/** What the host's control surface lists: key and size per stored preimage. */
export function hostPreimages(host: T3Host): Promise<Array<{ key: string; size: number }>> {
  return host.page.evaluate(() =>
    (window.__T3_HOST__ as unknown as { getPreimages(): Array<{ key: string; size: number }> }).getPreimages(),
  );
}

// ── report encryption key (lib/crypto/manual-key.ts) ──────────────────────

/** The fingerprint Settings → Report Encryption shows for `passphrase`. */
export function keyFingerprint(passphrase: string): string {
  const key = createHash("sha256").update(`t3rminal-manual-key:${passphrase.trim()}`).digest();
  return createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase();
}

/** Console lines from every frame (the product logs its host calls). */
export function captureConsole(host: T3Host): string[] {
  const lines: string[] = [];
  host.page.on("console", (m) => lines.push(m.text()));
  return lines;
}
