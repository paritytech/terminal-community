import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  coinsSaleRecord,
  dropPendingClaim,
  getPendingClaims,
  markClaimInSession,
  resumePendingClaims,
  savePendingClaim,
  type CoinsSaleDraft,
} from "@/lib/payments/coinage/pending-claims";
import { deriveTopUpId, topUpIdToHex, type TopUpStatusEvent } from "@/lib/payments/coinage/claim";
import { clearTable } from "@/lib/storage/host-storage";

/**
 * Claims handed to the host survive an app restart: the terminal persists a
 * pending claim before registering, and the next launch follows it to the
 * sale (or forgets it when nothing was credited). Outside a host, storage is
 * the in-memory driver, so these run without one.
 */

const draft: CoinsSaleDraft = {
  asset: "CASH",
  assetId: "1984",
  merchantAddress: "5Merchant",
  note: "Table 4",
  tip: "1.00",
};

type Script = TopUpStatusEvent[] | "NotFound" | "Dropped";

/** A status host that answers each registration id with a script. */
function fakeHost(scripts: Record<string, Script>) {
  const asked: string[] = [];
  return {
    asked,
    host: {
      subscribeTopUpStatus: (id: Uint8Array, onStatus: (s: TopUpStatusEvent) => void) => {
        const hex = topUpIdToHex(id);
        asked.push(hex);
        const script = scripts[hex] ?? "NotFound";
        const listeners: Array<(p: unknown) => void> = [];
        queueMicrotask(() => {
          if (script === "NotFound") listeners.forEach((cb) => cb({ name: "PaymentTopUpStatusErr::NotFound" }));
          else if (script === "Dropped") listeners.forEach((cb) => cb({ name: "PaymentTopUpStatusErr::Unknown" }));
          else script.forEach(onStatus);
        });
        return { unsubscribe: vi.fn(), onInterrupt: (cb: (p: unknown) => void) => listeners.push(cb) };
      },
    },
  };
}

const ids = (paymentId: string, ...attempts: number[]) => attempts.map((n) => topUpIdToHex(deriveTopUpId(paymentId, n)));

function deps(host: ReturnType<typeof fakeHost>["host"], existing: string[] = []) {
  const added: Array<Record<string, unknown>> = [];
  const watched: Array<{ saleId: string; topUpIdHex: string }> = [];
  return {
    added,
    watched,
    deps: {
      host,
      saleExists: async (id: string) => existing.includes(id),
      addSale: async (sale: Record<string, unknown>) => void added.push(sale),
      watchFinality: (t: { saleId: string; topUpIdHex: string }) => void watched.push(t),
    },
  };
}

beforeEach(async () => {
  await clearTable("pendingClaims");
});

describe("pending claims", () => {
  it("records the sale the host claimed after a restart, final at once", async () => {
    const [id1] = ids("pay-a", 1);
    await savePendingClaim({ paymentId: "pay-a", requestedAmount: "12.50", topUpIds: [id1], draft });
    const { host } = fakeHost({ [id1]: [{ type: "detecting" }, { type: "claimed", finalized: true }] });
    const d = deps(host);
    expect(await resumePendingClaims(d.deps)).toBe(1);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]).toMatchObject({
      saleId: "pay-a",
      amount: "12.50",
      topUpId: id1,
      note: "Table 4",
      tip: "1.00",
      customerAddress: "anonymous",
      syncStatus: "pending",
    });
    expect(d.added[0].finalizedAt).toBeInstanceOf(Date);
    expect(d.watched).toEqual([]);
    expect(await getPendingClaims()).toEqual([]);
  });

  it("hands a sale that is not final yet to the finality watcher", async () => {
    const [id1] = ids("pay-b", 1);
    await savePendingClaim({ paymentId: "pay-b", requestedAmount: "3.00", topUpIds: [id1], draft });
    const { host } = fakeHost({ [id1]: [{ type: "claimed", finalized: false }] });
    const d = deps(host);
    await resumePendingClaims(d.deps);
    expect(d.added[0].finalizedAt).toBeUndefined();
    expect(d.watched).toEqual([{ saleId: "pay-b", topUpIdHex: id1 }]);
  });

  it("records a partial claim at the credited amount", async () => {
    const [id1] = ids("pay-c", 1);
    await savePendingClaim({ paymentId: "pay-c", requestedAmount: "12.50", topUpIds: [id1], draft });
    const { host } = fakeHost({ [id1]: [{ type: "claimedPartially", actualClaimed: 5_000_000n }] });
    const d = deps(host);
    await resumePendingClaims(d.deps);
    expect(d.added[0]).toMatchObject({ amount: "5.00", requestedAmount: "12.50" });
    expect(d.added[0].finalizedAt).toBeInstanceOf(Date);
  });

  it("forgets a claim that credited nothing", async () => {
    const [a] = ids("pay-d", 1);
    const [b] = ids("pay-e", 1);
    await savePendingClaim({ paymentId: "pay-d", requestedAmount: "1.00", topUpIds: [a], draft });
    await savePendingClaim({ paymentId: "pay-e", requestedAmount: "1.00", topUpIds: [b], draft });
    const { host } = fakeHost({
      [a]: [{ type: "notClaimed" }],
      [b]: [{ type: "claimedPartially", actualClaimed: 0n }],
    });
    const d = deps(host);
    expect(await resumePendingClaims(d.deps)).toBe(0);
    expect(d.added).toEqual([]);
    expect(await getPendingClaims()).toEqual([]);
  });

  it("follows the registration the host knows, newest first", async () => {
    const [id1, id2] = ids("pay-f", 1, 2);
    await savePendingClaim({ paymentId: "pay-f", requestedAmount: "2.00", topUpIds: [id1, id2], draft });
    const f = fakeHost({ [id1]: [{ type: "claimed", finalized: true }] });
    const d = deps(f.host);
    await resumePendingClaims(d.deps);
    expect(f.asked).toEqual([id2, id1]);
    expect(d.added[0]).toMatchObject({ topUpId: id1 });
  });

  it("drops a claim no registration of which the host knows", async () => {
    await savePendingClaim({ paymentId: "pay-g", requestedAmount: "2.00", topUpIds: ids("pay-g", 1), draft });
    const d = deps(fakeHost({}).host);
    await resumePendingClaims(d.deps);
    expect(d.added).toEqual([]);
    expect(await getPendingClaims()).toEqual([]);
  });

  it("keeps a claim whose status could not be read, for the next launch", async () => {
    const [id1] = ids("pay-h", 1);
    await savePendingClaim({ paymentId: "pay-h", requestedAmount: "2.00", topUpIds: [id1], draft });
    const d = deps(fakeHost({ [id1]: "Dropped" }).host);
    await resumePendingClaims(d.deps);
    expect((await getPendingClaims()).map((c) => c.paymentId)).toEqual(["pay-h"]);
  });

  it("leaves claims alone that are already recorded or running in this session", async () => {
    const [x] = ids("pay-i", 1);
    const [y] = ids("pay-j", 1);
    await savePendingClaim({ paymentId: "pay-i", requestedAmount: "2.00", topUpIds: [x], draft });
    await savePendingClaim({ paymentId: "pay-j", requestedAmount: "2.00", topUpIds: [y], draft });
    markClaimInSession("pay-j");
    const f = fakeHost({ [x]: [{ type: "claimed", finalized: true }], [y]: [{ type: "claimed", finalized: true }] });
    const d = deps(f.host, ["pay-i"]);
    await resumePendingClaims(d.deps);
    expect(d.added).toEqual([]);
    expect(f.asked).toEqual([]);
    expect((await getPendingClaims()).map((c) => c.paymentId)).toEqual(["pay-j"]);
    await dropPendingClaim("pay-j");
  });

  it("extends a pending claim with a retry's registration ids", async () => {
    const [id1, id2] = ids("pay-k", 1, 2);
    await savePendingClaim({ paymentId: "pay-k", requestedAmount: "2.00", topUpIds: [id1], draft });
    await savePendingClaim({ paymentId: "pay-k", requestedAmount: "2.00", topUpIds: [id1, id2], draft });
    const [claim] = await getPendingClaims();
    expect(claim.topUpIds).toEqual([id1, id2]);
  });

  it("keeps looking past a newer registration that credited nothing", async () => {
    // A retry after the first registration already took the coins: the host
    // accepts the new id, which then settles NotClaimed.
    const [id1, id2] = ids("pay-l", 1, 2);
    await savePendingClaim({ paymentId: "pay-l", requestedAmount: "8.00", topUpIds: [id1, id2], draft });
    const f = fakeHost({ [id2]: [{ type: "notClaimed" }], [id1]: [{ type: "claimed", finalized: true }] });
    const d = deps(f.host);
    expect(await resumePendingClaims(d.deps)).toBe(1);
    expect(f.asked).toEqual([id2, id1]);
    expect(d.added[0]).toMatchObject({ saleId: "pay-l", amount: "8.00", topUpId: id1 });
  });

  it("dates the sale when the claim was registered, not at the relaunch", async () => {
    const [id1] = ids("pay-m", 1);
    await savePendingClaim({ paymentId: "pay-m", requestedAmount: "2.00", topUpIds: [id1], draft });
    const [{ createdAt }] = await getPendingClaims();
    const d = deps(fakeHost({ [id1]: [{ type: "claimed", finalized: true }] }).host);
    await resumePendingClaims(d.deps);
    expect((d.added[0].timestamp as Date).toISOString()).toBe(createdAt);
  });

  it("does not let one stalled claim hold up the others, and keeps it for later", async () => {
    const [stuck] = ids("pay-n", 1);
    const [done] = ids("pay-o", 1);
    await savePendingClaim({ paymentId: "pay-n", requestedAmount: "1.00", topUpIds: [stuck], draft });
    await savePendingClaim({ paymentId: "pay-o", requestedAmount: "1.00", topUpIds: [done], draft });
    const d = deps(fakeHost({ [stuck]: [{ type: "detecting" }], [done]: [{ type: "claimed", finalized: true }] }).host);
    expect(await resumePendingClaims({ ...d.deps, ttlMs: 50 })).toBe(1);
    expect(d.added.map((s) => s.saleId)).toEqual(["pay-o"]);
    expect((await getPendingClaims()).map((c) => c.paymentId)).toEqual(["pay-n"]);
    await dropPendingClaim("pay-n");
  });

  it("records a claim once when two resumes overlap", async () => {
    const [id1] = ids("pay-p", 1);
    await savePendingClaim({ paymentId: "pay-p", requestedAmount: "1.00", topUpIds: [id1], draft });
    const f = fakeHost({ [id1]: [{ type: "claimed", finalized: true }] });
    const d = deps(f.host);
    const [a, b] = await Promise.all([resumePendingClaims(d.deps), resumePendingClaims(d.deps)]);
    expect(a + b).toBe(1);
    expect(d.added).toHaveLength(1);
  });

  it("gives up on a claim nobody could settle for 30 days", async () => {
    const [id1] = ids("pay-q", 1);
    await savePendingClaim({ paymentId: "pay-q", requestedAmount: "1.00", topUpIds: [id1], draft });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeHost({ [id1]: [{ type: "claimed", finalized: true }] });
    const d = deps(f.host);
    await resumePendingClaims({ ...d.deps, now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 });
    expect(f.asked).toEqual([]);
    expect(await getPendingClaims()).toEqual([]);
  });

  it("builds the same sale record the in-session path writes", () => {
    const at = new Date("2026-11-13T10:00:00Z");
    const record = coinsSaleRecord(
      draft,
      { paymentId: "p", amount: "4.00", requestedAmount: "5.00", partial: true, finalized: true, topUpId: "ab" },
      at,
    );
    expect(record).toMatchObject({
      saleId: "p",
      amount: "4.00",
      amountPlanck: "4000000",
      requestedAmount: "5.00",
      requestedAmountPlanck: "5000000",
      finalizedAt: at,
      blockNumber: 0,
      blockHash: "p",
      type: "incoming",
    });
  });
});
