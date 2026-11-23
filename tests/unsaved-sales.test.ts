import { beforeEach, describe, expect, it, vi } from "vitest";

const watched: Array<{ saleId: string; topUpIdHex: string }> = [];
vi.mock("@/lib/payments/coinage/topup-watcher", () => ({
  watchTopUpFinality: (t: { saleId: string; topUpIdHex: string }) => void watched.push(t),
}));

import { getUnsavedSales, keepUnsavedSale, saveUnsavedSales } from "@/lib/payments/coinage/unsaved-sales";
import { readTable, resetStorageForTests, useStorageDriverForTests, type StorageDriver } from "@/lib/storage/host-storage";
import type { SaleRecord } from "@/lib/storage/types";

/**
 * A paid sale the host would not store is kept until the storage takes it
 * (lib/payments/coinage/unsaved-sales.ts), and saved once.
 */

function host() {
  const data = new Map<string, string>();
  let full = true;
  const driver: StorageDriver = {
    readString: async (k) => data.get(k) ?? "",
    writeString: async (k, v) => {
      if (full) throw Object.assign(new Error("Storage is full"), { name: "StorageErr::Full" });
      data.set(k, v);
    },
    clear: async (k) => void data.delete(k),
  };
  return { data, driver, setFull: (f: boolean) => (full = f) };
}

const record = (saleId: string) =>
  ({ saleId, amount: "2.00", merchantAddress: "5M", customerAddress: "anonymous", timestamp: new Date(), type: "incoming" }) as never;

beforeEach(() => {
  resetStorageForTests();
  watched.length = 0;
});

describe("unsaved sales", () => {
  it("keeps a sale until the storage takes it, then saves it once and follows its claim", async () => {
    const h = host();
    useStorageDriverForTests(h.driver);
    keepUnsavedSale({ record: record("u1"), paymentId: "u1", topUpIdHex: "ab", finalized: false });
    expect(await saveUnsavedSales()).toBe(1);
    expect(getUnsavedSales().map((s) => s.paymentId)).toContain("u1");

    h.setFull(false);
    expect(await saveUnsavedSales()).toBe(0);
    const sales = await readTable<SaleRecord>("sales");
    expect(sales.filter((s) => s.saleId === "u1")).toHaveLength(1);
    expect(watched).toEqual([{ saleId: "u1", topUpIdHex: "ab" }]);
    // Saving again finds nothing left and stores nothing twice.
    expect(await saveUnsavedSales()).toBe(0);
    expect((await readTable<SaleRecord>("sales")).filter((s) => s.saleId === "u1")).toHaveLength(1);
  });

  it("does not arm the watcher for a sale already final", async () => {
    const h = host();
    h.setFull(false);
    useStorageDriverForTests(h.driver);
    keepUnsavedSale({ record: record("u2"), paymentId: "u2", topUpIdHex: "cd", finalized: true });
    await saveUnsavedSales();
    expect(watched).toEqual([]);
  });

  it("still saves after a call that found nothing to save (no latch)", async () => {
    const h = host();
    h.setFull(false);
    useStorageDriverForTests(h.driver);
    expect(await saveUnsavedSales()).toBe(0);
    keepUnsavedSale({ record: record("u3"), paymentId: "u3", topUpIdHex: "ef", finalized: true });
    expect(await saveUnsavedSales()).toBe(0);
    expect((await readTable<SaleRecord>("sales")).some((s) => s.saleId === "u3")).toBe(true);
  });

  it("a sale kept during a save run is saved by that run", async () => {
    const h = host();
    h.setFull(false);
    useStorageDriverForTests(h.driver);
    keepUnsavedSale({ record: record("u4"), paymentId: "u4", topUpIdHex: "01", finalized: true });
    const run = saveUnsavedSales();
    keepUnsavedSale({ record: record("u5"), paymentId: "u5", topUpIdHex: "02", finalized: true });
    expect(await run).toBe(0);
    const ids = (await readTable<SaleRecord>("sales")).map((s) => s.saleId);
    expect(ids).toEqual(expect.arrayContaining(["u4", "u5"]));
  });
});
