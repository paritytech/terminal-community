import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRecord,
  getSaleStorageHealth,
  onStorageChange,
  getStorageHealth,
  mutateTable,
  onStorageHealth,
  probeStorage,
  readTable,
  resetStorageForTests,
  setStorageTimeoutForTests,
  StorageError,
  updateWhere,
  useStorageDriverForTests,
  writeTable,
  type StorageDriver,
} from "@/lib/storage/host-storage";
import {
  addCsvReport,
  addSaleRecord,
  getAllCsvReports,
  markSaleFinalized,
  markSaleReverted,
} from "@/lib/storage/database";
import type { CsvReportRecord, SaleRecord } from "@/lib/storage/types";

/**
 * The storage adapter keeps records honest (lib/storage/host-storage.ts): a
 * failed host call is an error with a health the app can show, never a quiet
 * switch to memory; changes to one table run one at a time; a table that
 * cannot be read is never written over.
 */

/** A host store with scriptable failures. */
function fakeHost() {
  const data = new Map<string, string>();
  const host = {
    data,
    failWrites: null as null | (() => Error),
    /** Refuse as full any write whose value is longer than this. */
    maxValue: Infinity,
    failReads: null as null | (() => Error),
    hangWrites: false,
    writes: [] as string[],
    driver: {
      readString: async (key: string) => {
        if (host.failReads) throw host.failReads();
        return data.get(key) ?? "";
      },
      writeString: async (key: string, value: string) => {
        if (host.hangWrites) return new Promise(() => {});
        if (host.failWrites) throw host.failWrites();
        if (value.length > host.maxValue) throw full();
        // Let other work interleave between read and write, as a real bridge does.
        await new Promise((r) => setTimeout(r, 1));
        data.set(key, value);
        host.writes.push(key);
      },
      clear: async (key: string) => {
        data.delete(key);
      },
    } satisfies StorageDriver,
  };
  return host;
}

const full = () => Object.assign(new Error("Storage is full"), { name: "StorageErr::Full" });
const bridge = () => Object.assign(new Error("test: bridge unhealthy"), { name: "StorageErr::Unknown" });

const sale = (saleId: string): Omit<SaleRecord, "id" | "createdAt"> =>
  ({
    saleId,
    amount: "1.00",
    asset: "CASH",
    merchantAddress: "5M",
    customerAddress: "anonymous",
    timestamp: new Date("2026-11-20T10:00:00Z"),
    type: "incoming",
    syncStatus: "pending",
  }) as unknown as Omit<SaleRecord, "id" | "createdAt">;

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  resetStorageForTests();
  setStorageTimeoutForTests(15_000);
  host = fakeHost();
  useStorageDriverForTests(host.driver);
});

describe("host failures", () => {
  it("rejects a refused write and reports the store full — nothing goes to memory", async () => {
    host.failWrites = full;
    const seen: unknown[] = [];
    onStorageHealth((h) => seen.push(h));
    const write = addRecord<{ id?: number; saleId: string }>("sales", { saleId: "a" });
    await expect(write).rejects.toBeInstanceOf(StorageError);
    await expect(write).rejects.toMatchObject({ kind: "full", op: "write", table: "sales" });
    expect(getStorageHealth()).toEqual({ ok: false, kind: "full", table: "sales" });
    expect(seen).toHaveLength(1);
    // Later writes go to the host again, not to a memory store.
    host.failWrites = null;
    await addRecord<{ id?: number; saleId: string }>("sales", { saleId: "b" });
    expect(JSON.parse(host.data.get("sales")!)).toEqual([{ saleId: "b", id: 1 }]);
    expect(getStorageHealth()).toEqual({ ok: true });
  });

  it("tries a bridge failure once more before giving up", async () => {
    const write = host.driver.writeString;
    let calls = 0;
    host.driver.writeString = async (k, v) => {
      calls++;
      if (calls === 1) throw bridge();
      return write(k, v);
    };
    await writeTable("settings", [{ key: "a" }]);
    expect(calls).toBe(2);
    expect(JSON.parse(host.data.get("settings")!)).toEqual([{ key: "a" }]);
    expect(getStorageHealth()).toEqual({ ok: true });
  });

  it("does not retry a full store", async () => {
    let calls = 0;
    host.driver.writeString = async () => {
      calls++;
      throw full();
    };
    await expect(writeTable("sales", [])).rejects.toMatchObject({ kind: "full" });
    expect(calls).toBe(1);
  });

  it("times out a host that never answers", async () => {
    setStorageTimeoutForTests(20);
    host.hangWrites = true;
    await expect(writeTable("sales", [])).rejects.toMatchObject({ kind: "timeout" });
    expect(getStorageHealth()).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("reports an unreadable host and does not hand back an empty table", async () => {
    host.failReads = bridge;
    await expect(readTable("sales")).rejects.toMatchObject({ kind: "unavailable", op: "read" });
    expect(getStorageHealth()).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("a probe write clears the health once the host takes writes again", async () => {
    host.failWrites = full;
    await expect(writeTable("sales", [])).rejects.toBeTruthy();
    expect((await probeStorage()).ok).toBe(false);
    host.failWrites = null;
    expect(await probeStorage()).toEqual({ ok: true });
  });
});

describe("tables", () => {
  it("never writes over a table it cannot read", async () => {
    host.data.set("sales", "{not json");
    await expect(addSaleRecord(sale("x"))).rejects.toMatchObject({ kind: "corrupt" });
    expect(host.data.get("sales")).toBe("{not json");
    host.data.set("sales", JSON.stringify({ an: "object" }));
    await expect(readTable("sales")).rejects.toMatchObject({ kind: "corrupt" });
    expect(host.writes).toEqual([]);
  });

  it("keeps every change when writes to one table overlap", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => addSaleRecord(sale(`s${i}`))));
    const stored = await readTable<SaleRecord>("sales");
    expect(stored.map((s) => s.saleId).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `s${i}`).sort());
    expect(new Set(stored.map((s) => s.id)).size).toBe(20);
  });

  it("records a sale once, however often it is added", async () => {
    const [a, b] = await Promise.all([addSaleRecord(sale("dup")), addSaleRecord(sale("dup"))]);
    expect(a).toBe(b);
    expect(await readTable<SaleRecord>("sales")).toHaveLength(1);
  });

  it("updates every stored row of a sale, legacy duplicates included", async () => {
    host.data.set(
      "sales",
      JSON.stringify([
        { ...sale("d"), id: 1 },
        { ...sale("d"), id: 2 },
        { ...sale("other"), id: 3 },
      ]),
    );
    await markSaleReverted("d");
    const rows = await readTable<SaleRecord>("sales");
    expect(rows.filter((r) => r.saleId === "d").every((r) => !!r.revertedAt)).toBe(true);
    expect(rows.find((r) => r.saleId === "other")?.revertedAt).toBeUndefined();
    await markSaleFinalized("other");
    const after = await readTable<SaleRecord>("sales");
    expect(after.filter((r) => r.finalizedAt).map((r) => r.saleId)).toEqual(["other"]);
  });

  it("finds the next id of a very large table (no argument-count limit)", async () => {
    const big = Array.from({ length: 500_000 }, (_, i) => ({ id: i + 1 }));
    host.data.set("big", JSON.stringify(big));
    const spy = vi.spyOn(Math, "max");
    expect(await addRecord("big", {})).toBe(500_001);
    expect(spy.mock.calls.every((args) => args.length < 1_000)).toBe(true);
    spy.mockRestore();
  });

  it("updateWhere sees each row as it is under the lock", async () => {
    await writeTable("t", [{ k: 1, n: 0 }]);
    await Promise.all(
      Array.from({ length: 10 }, () => updateWhere<{ k: number; n: number }>("t", (r) => r.k === 1, (r) => ({ n: r.n + 1 }))),
    );
    expect(await readTable("t")).toEqual([{ k: 1, n: 10 }]);
  });

  it("a change that throws leaves the table as it was and does not block the next", async () => {
    await writeTable("t", [1]);
    await expect(mutateTable("t", () => { throw new Error("no"); })).rejects.toThrow("no");
    await writeTable("t", [1, 2]);
    expect(await readTable("t")).toEqual([1, 2]);
  });
});

describe("CSV cache", () => {
  const csv = (chars: number, at: number): Omit<CsvReportRecord, "id"> =>
    ({ csv: "x".repeat(chars), createdAt: new Date(at).toISOString(), fileName: `f${at}.csv` }) as unknown as Omit<CsvReportRecord, "id">;

  it("is bounded by size as well as count, newest kept", async () => {
    for (let i = 0; i < 5; i++) await addCsvReport(csv(300_000, 1_000 + i));
    const kept = await getAllCsvReports();
    expect(kept.length).toBe(3);
    expect(kept.reduce((n, r) => n + r.csv.length, 0)).toBeLessThanOrEqual(1_000_000);
    expect(kept[0].createdAt).toBe(new Date(1_004).toISOString());
  });

  it("does not keep one export larger than the whole cache", async () => {
    expect(await addCsvReport(csv(1_500_000, 1))).toBeNull();
    expect(await getAllCsvReports()).toEqual([]);
  });
});

describe("health is about the table that failed", () => {
  it("a corrupt sales table stays reported while other tables read fine, and a probe does not clear it", async () => {
    host.data.set("sales", JSON.stringify({ not: "an array" }));
    await expect(readTable("sales")).rejects.toMatchObject({ kind: "corrupt" });
    await readTable("settings");
    await writeTable("settings", [{ key: "a" }]);
    expect(getStorageHealth()).toEqual({ ok: false, kind: "corrupt", table: "sales" });
    expect(await probeStorage()).toMatchObject({ ok: false, kind: "corrupt" });
    // Fixed (e.g. by support): the next clean read clears it.
    host.data.set("sales", "[]");
    expect(await probeStorage()).toEqual({ ok: true });
  });

  it("a full sales table is not cleared by a small write elsewhere, and the probe writes as much as a sale would", async () => {
    await writeTable("sales", Array.from({ length: 50 }, (_, i) => ({ id: i + 1, saleId: `s${i}` })));
    host.maxValue = 100;
    await expect(addSaleRecord(sale("big"))).rejects.toMatchObject({ kind: "full", table: "sales" });
    await writeTable("settings", [{ k: 1 }]); // small: fits
    expect(getStorageHealth()).toMatchObject({ ok: false, kind: "full", table: "sales" });
    expect(await probeStorage()).toMatchObject({ ok: false, kind: "full" });
    host.maxValue = Infinity;
    expect(await probeStorage()).toEqual({ ok: true });
  });

  it("a bridge failure is cleared by any call that goes through", async () => {
    host.failReads = bridge;
    await expect(readTable("sales")).rejects.toMatchObject({ kind: "unavailable" });
    host.failReads = null;
    await readTable("settings");
    expect(getStorageHealth()).toEqual({ ok: true });
  });

  it("tells the screens that failed to read a table to read it again on recovery", async () => {
    host.failReads = bridge;
    await expect(readTable("sales")).rejects.toBeTruthy();
    const refetch = vi.fn();
    onStorageChange("sales", refetch);
    host.failReads = null;
    await probeStorage();
    expect(refetch).toHaveBeenCalled();
  });

  it("does not let a timed-out write land over a newer table", async () => {
    setStorageTimeoutForTests(20);
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    const write = host.driver.writeString;
    let first = true;
    host.driver.writeString = async (k, v) => {
      if (first) {
        first = false;
        await late; // answers long after the timeout…
        host.data.set(k, v); // …and lands
        return;
      }
      return write(k, v);
    };
    await expect(writeTable("t", ["old"])).rejects.toMatchObject({ kind: "timeout" });
    // The next change waits for the late write before reading and writing.
    const next = writeTable("t", ["new"]);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await next;
    expect(JSON.parse(host.data.get("t")!)).toEqual(["new"]);
  });
});

describe("probes and sale health", () => {
  it("a probe after a bridge outage does not mistake its own scratch key for a corrupt table", async () => {
    host.failReads = bridge;
    host.failWrites = bridge;
    await expect(readTable("sales")).rejects.toBeTruthy();
    expect((await probeStorage()).ok).toBe(false);
    host.failReads = null;
    host.failWrites = null;
    expect(await probeStorage()).toEqual({ ok: true });
    expect(await probeStorage()).toEqual({ ok: true });
    expect(getStorageHealth()).toEqual({ ok: true });
  });

  it("a full store stays full until there is room for what the refused write needed (quota on the whole store)", async () => {
    // A total quota: the sum of all stored values.
    let quota = Infinity;
    const used = () => [...host.data.values()].reduce((n, v) => n + v.length, 0);
    const write = host.driver.writeString;
    host.driver.writeString = async (k, v) => {
      const after = used() - (host.data.get(k)?.length ?? 0) + v.length;
      if (after > quota) throw full();
      return write(k, v);
    };
    await writeTable("sales", Array.from({ length: 20 }, (_, i) => ({ id: i + 1, saleId: `s${i}` })));
    quota = used() + 10; // no room for one more sale
    await expect(addSaleRecord(sale("next"))).rejects.toMatchObject({ kind: "full" });
    // Rewriting the table as it is would fit; the probe must not take that as room.
    expect(await probeStorage()).toMatchObject({ ok: false, kind: "full" });
    quota = Infinity;
    expect(await probeStorage()).toEqual({ ok: true });
    await addSaleRecord(sale("next"));
  });

  it("a failed sales write is not cleared by reading another table", async () => {
    let fail = true;
    const write = host.driver.writeString;
    host.driver.writeString = async (k, v) => {
      if (fail && k === "sales") throw bridge();
      return write(k, v);
    };
    await expect(addSaleRecord(sale("a"))).rejects.toMatchObject({ kind: "unavailable" });
    await readTable("settings");
    await writeTable("settings", [{ k: 1 }]);
    expect(getSaleStorageHealth()).toMatchObject({ ok: false, table: "sales" });
    fail = false;
    expect(await probeStorage()).toEqual({ ok: true });
  });

  it("a corrupt table sales do not use is reported but does not stop sales", async () => {
    host.data.set("csvReports", "{}");
    await expect(readTable("csvReports")).rejects.toMatchObject({ kind: "corrupt" });
    expect(getStorageHealth()).toMatchObject({ ok: false, kind: "corrupt", table: "csvReports" });
    expect(getSaleStorageHealth()).toEqual({ ok: true });
    expect(await probeStorage()).toEqual({ ok: true });
  });
});

describe("failures that only a write can clear", () => {
  it("a passing read hiccup on a full table does not make the store forget it is full", async () => {
    let quota = Infinity;
    const used = () => [...host.data.values()].reduce((n, v) => n + v.length, 0);
    const write = host.driver.writeString;
    host.driver.writeString = async (k, v) => {
      if (used() - (host.data.get(k)?.length ?? 0) + v.length > quota) throw full();
      return write(k, v);
    };
    await writeTable("sales", [{ id: 1, saleId: "a" }]);
    quota = used() + 5;
    await expect(addSaleRecord(sale("b"))).rejects.toMatchObject({ kind: "full" });
    host.failReads = bridge;
    await expect(readTable("sales")).rejects.toBeTruthy();
    host.failReads = null;
    await readTable("settings");
    expect(getSaleStorageHealth()).toMatchObject({ ok: false, kind: "full", table: "sales" });
    expect((await probeStorage()).ok).toBe(false);
  });

  it("does not report room when its scratch value could not be removed", async () => {
    let quota = Infinity;
    const used = () => [...host.data.values()].reduce((n, v) => n + v.length, 0);
    const write = host.driver.writeString;
    host.driver.writeString = async (k, v) => {
      if (used() - (host.data.get(k)?.length ?? 0) + v.length > quota) throw full();
      return write(k, v);
    };
    await writeTable("sales", [{ id: 1, saleId: "a" }]);
    quota = used() + 5;
    await expect(addSaleRecord(sale("b"))).rejects.toMatchObject({ kind: "full" });
    quota = Infinity;
    host.driver.clear = async () => {
      throw bridge();
    };
    expect((await probeStorage()).ok).toBe(false);
  });

  it("a full store the probe itself hit is not forgotten on the next read", async () => {
    host.failReads = bridge;
    await expect(readTable("sales")).rejects.toBeTruthy();
    host.failReads = null;
    host.failWrites = full;
    expect((await probeStorage()).ok).toBe(false);
    await readTable("settings");
    expect(getSaleStorageHealth()).toMatchObject({ ok: false, kind: "full" });
    host.failWrites = null;
    expect(await probeStorage()).toEqual({ ok: true });
  });

  it("a large write elsewhere refused as full stops sales only until there is room for a sale", async () => {
    let quota = Infinity;
    const used = () => [...host.data.values()].reduce((n, v) => n + v.length, 0);
    const write = host.driver.writeString;
    host.driver.writeString = async (k, v) => {
      if (used() - (host.data.get(k)?.length ?? 0) + v.length > quota) throw full();
      return write(k, v);
    };
    quota = 50_000;
    await expect(writeTable("csvReports", [{ csv: "x".repeat(60_000) }])).rejects.toMatchObject({ kind: "full" });
    expect(getSaleStorageHealth()).toMatchObject({ ok: false, kind: "full" });
    // Room for a sale, not for the export: sales go on, the export stays refused.
    expect(await probeStorage()).toEqual({ ok: true });
    expect(getStorageHealth()).toMatchObject({ ok: false, kind: "full", table: "csvReports" });
    await addSaleRecord(sale("ok"));
  });
});

