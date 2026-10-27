import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_ID, buildSnapshot, type MerchantSnapshot } from "@/lib/pocket/merchant-card";
import { registerMerchantCard, type MerchantCardDeps } from "@/lib/pocket/worker-core";
import type { RendererNode } from "@/lib/pocket/nodes";

/**
 * The Pocket worker against a fake host (lib/pocket/worker-core.ts). The host
 * stores every face it is sent, so the worker must send one only when what the
 * card shows changed — on its first draw, on a pushed storage change, or when
 * a poll finds a new snapshot — and must stop both when the card leaves the
 * screen.
 */

const NOW = new Date(2026, 9, 28, 15, 30);
const snapshotOf = (...planck: string[]): MerchantSnapshot =>
  buildSnapshot(
    planck.map((p, i) => ({ saleId: `s${i}`, amountPlanck: p, timestamp: new Date(2026, 9, 28, 10, i), type: "incoming" as const })),
    { symbol: "CASH", decimals: 6, now: NOW },
  );

function fakeHost(initial: MerchantSnapshot | null) {
  let stored = initial;
  let draw: Parameters<MerchantCardDeps["drawCard"]>[1] | null = null;
  let pushChange: (() => void) | null = null;
  const sent: RendererNode[] = [];
  const stopWatching = vi.fn();
  const deps: MerchantCardDeps = {
    drawCard: (cardId, handler) => {
      expect(cardId).toBe(CARD_ID);
      draw = handler;
    },
    readSnapshot: vi.fn(async () => stored),
    watchSnapshot: vi.fn(async (onChange: () => void) => {
      pushChange = onChange;
      return stopWatching;
    }),
    markSeen: vi.fn(async () => {}),
    now: () => NOW,
    pollMs: 1_000,
    log: { info: () => {}, warn: () => {} },
  };
  return {
    deps,
    sent,
    stopWatching,
    store: (next: MerchantSnapshot | null) => (stored = next),
    show: async () => (await draw!((face) => sent.push(face))) as (() => void) | void,
    push: () => pushChange?.(),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the merchant card worker", () => {
  it("draws once on screen, and marks the card seen", async () => {
    const host = fakeHost(snapshotOf("1000000"));
    registerMerchantCard(host.deps);
    await host.show();
    expect(host.sent).toHaveLength(1);
    expect(JSON.stringify(host.sent[0])).toContain("1.00 CASH");
    expect(host.deps.markSeen).toHaveBeenCalledTimes(1);
  });

  it("sends a new face only when the snapshot changed", async () => {
    const host = fakeHost(snapshotOf("1000000"));
    registerMerchantCard(host.deps);
    await host.show();

    await vi.advanceTimersByTimeAsync(3_000);
    host.push();
    await flush();
    expect(host.sent).toHaveLength(1);

    host.store(snapshotOf("1000000", "2000000"));
    host.push();
    await flush();
    expect(host.sent).toHaveLength(2);
    expect(JSON.stringify(host.sent[1])).toContain("3.00 CASH");
  });

  it("picks a new snapshot up by polling where the host cannot push", async () => {
    const host = fakeHost(null);
    host.deps.watchSnapshot = async () => null;
    registerMerchantCard(host.deps);
    await host.show();
    expect(JSON.stringify(host.sent[0])).toContain("No sales yet");

    host.store(snapshotOf("5000000"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.sent).toHaveLength(2);
  });

  it("stops polling and watching when the card leaves the screen", async () => {
    const host = fakeHost(snapshotOf("1000000"));
    registerMerchantCard(host.deps);
    const cleanup = await host.show();
    cleanup?.();
    expect(host.stopWatching).toHaveBeenCalledTimes(1);

    host.store(snapshotOf("9000000"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.sent).toHaveLength(1);
  });

  it("keeps the last face when a read fails, and recovers on the next one", async () => {
    const host = fakeHost(snapshotOf("1000000"));
    registerMerchantCard(host.deps);
    await host.show();

    vi.mocked(host.deps.readSnapshot).mockRejectedValueOnce(new Error("host storage busy"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.sent).toHaveLength(1);

    host.store(snapshotOf("4000000"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.sent).toHaveLength(2);
  });
});
