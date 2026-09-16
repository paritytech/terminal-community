import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTopUpId, topUpIdToHex, type TopUpStatusEvent } from "@/lib/payments/coinage/claim";
import {
  activeTopUpWatchCount,
  resumePendingTopUpWatches,
  runTopUpWatch,
  stopAllTopUpWatches,
  watchTopUpFinality,
  type TopUpWatcherDeps,
} from "@/lib/payments/coinage/topup-watcher";
import { scriptedHost } from "./coinage-claim.test";

const SALE = "pay-abcd";
const ID = deriveTopUpId(SALE, 1);
const target = { saleId: SALE, topUpIdHex: topUpIdToHex(ID) };

type Run = Array<TopUpStatusEvent | { interrupt: unknown }>;

function deps(runs: Run[], pending: Array<{ saleId: string; topUpIdHex: string }> = []) {
  const h = scriptedHost([], runs);
  const d: TopUpWatcherDeps = {
    host: h.host,
    markSaleFinalized: vi.fn(async () => {}),
    recordSaleClaimShortfall: vi.fn(async () => {}),
    markSaleReverted: vi.fn(async () => {}),
    getSalesAwaitingClaimFinality: vi.fn(async () => pending),
    sleep: async () => {},
    maxResubscribes: 2,
  };
  return { d, h };
}

afterEach(() => stopAllTopUpWatches());

describe("runTopUpWatch", () => {
  it("waits past claimed(finalized=false) and stamps the sale final on claimed(finalized=true)", async () => {
    const { d, h } = deps([[{ type: "claimed", finalized: false }, { type: "claimed", finalized: true }]]);
    const result = await runTopUpWatch(target, d, new AbortController().signal);
    expect(result).toBe("final");
    expect(d.markSaleFinalized).toHaveBeenCalledWith(SALE);
    expect(d.recordSaleClaimShortfall).not.toHaveBeenCalled();
    expect(h.unsubscribed).toEqual([topUpIdToHex(ID)]);
  });

  it("records a shortfall when a reorg turns the claim into claimedPartially", async () => {
    const { d } = deps([[{ type: "claimed", finalized: false }, { type: "claimedPartially", actualClaimed: 4_000_000n }]]);
    await runTopUpWatch(target, d, new AbortController().signal);
    expect(d.recordSaleClaimShortfall).toHaveBeenCalledWith(SALE, 4_000_000n);
    expect(d.markSaleFinalized).not.toHaveBeenCalled();
  });

  it("marks the sale reverted when the host's last word is notClaimed", async () => {
    const { d } = deps([[{ type: "claimed", finalized: false }, { type: "notClaimed" }]]);
    await runTopUpWatch(target, d, new AbortController().signal);
    expect(d.markSaleReverted).toHaveBeenCalledWith(SALE);
  });

  it("re-subscribes when the host drops the subscription, then applies the final status", async () => {
    const { d, h } = deps([[{ interrupt: { name: "PaymentTopUpStatusErr::Unknown" } }], [{ type: "claimed", finalized: true }]]);
    const result = await runTopUpWatch(target, d, new AbortController().signal);
    expect(result).toBe("final");
    expect(h.subscribeTopUpStatus).toHaveBeenCalledTimes(2);
    expect(d.markSaleFinalized).toHaveBeenCalledWith(SALE);
  });

  it("drops the watch, leaving the sale confirming, when the host does not know the id", async () => {
    const { d } = deps([[{ interrupt: { name: "PaymentTopUpStatusErr::NotFound" } }]]);
    const result = await runTopUpWatch(target, d, new AbortController().signal);
    expect(result).toBe("dropped");
    expect(d.markSaleFinalized).not.toHaveBeenCalled();
    expect(d.markSaleReverted).not.toHaveBeenCalled();
  });

  it("gives up after too many drops", async () => {
    const drop: Run = [{ interrupt: { name: "PaymentTopUpStatusErr::Unknown" } }];
    const { d, h } = deps([drop, drop, drop]);
    const result = await runTopUpWatch(target, d, new AbortController().signal);
    expect(result).toBe("dropped");
    expect(h.subscribeTopUpStatus).toHaveBeenCalledTimes(3);
  });

  it("stops on abort without touching the sale", async () => {
    const { d, h } = deps([[{ type: "claimed", finalized: false }, { type: "claimed", finalized: false }]]);
    const abort = new AbortController();
    const pending = runTopUpWatch(target, d, abort.signal);
    await new Promise((r) => setTimeout(r, 1));
    abort.abort();
    expect(await pending).toBe("aborted");
    expect(h.unsubscribed).toEqual([topUpIdToHex(ID)]);
    expect(d.markSaleFinalized).not.toHaveBeenCalled();
  });
});

describe("watchTopUpFinality / resumePendingTopUpWatches", () => {
  it("is idempotent per sale and clears itself when the watch ends", async () => {
    const { d, h } = deps([[{ type: "claimed", finalized: true }]]);
    watchTopUpFinality(target, d);
    watchTopUpFinality(target, d);
    expect(activeTopUpWatchCount()).toBe(1);
    await vi.waitFor(() => expect(d.markSaleFinalized).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(activeTopUpWatchCount()).toBe(0));
    expect(h.subscribeTopUpStatus).toHaveBeenCalledTimes(1);
  });

  it("re-arms a watch for every sale still confirming", async () => {
    const other = { saleId: "pay-ef01", topUpIdHex: topUpIdToHex(deriveTopUpId("pay-ef01", 1)) };
    const { d } = deps([[{ type: "claimed", finalized: true }], [{ type: "notClaimed" }]], [target, other]);
    const count = await resumePendingTopUpWatches(d);
    expect(count).toBe(2);
    await vi.waitFor(() => expect(d.markSaleFinalized).toHaveBeenCalledWith(SALE));
    await vi.waitFor(() => expect(d.markSaleReverted).toHaveBeenCalledWith("pay-ef01"));
  });
});
