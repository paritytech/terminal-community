/**
 * Background watcher that follows a coins claim from "in a best-chain block"
 * to its last word, without holding up the merchant UI.
 *
 * The terminal records a sale and shows "Payment received" at the host's
 * first `claimed { finalized: false }`. That is not final: a reorg can still
 * shrink it to `claimedPartially { actualClaimed }` or, in the worst case,
 * `notClaimed` (host owner: "Claimed(finalized=false) doesn't necessarily
 * mean that later there will be Claimed(finalized=true)"). So the sale row is
 * written **without** `finalizedAt`, carries the host's `topUpId`, and this
 * module keeps `subscribeTopUpStatus(id)` open until one of the terminal
 * statuses lands:
 *
 *   claimed { finalized: true }        → markSaleFinalized
 *   claimedPartially { actualClaimed } → recordSaleClaimShortfall (amount ←
 *                                        credited, requested kept, finalized)
 *   notClaimed                         → markSaleReverted
 *
 * The host keeps statuses indefinitely, so a subscription opened after an
 * app restart still gets the outcome: `resumePendingTopUpWatches()` re-arms a
 * watch for every sale that is still confirming (runs once the host is
 * connected — see lib/components/topup-watcher-boot.tsx).
 *
 * Side-effect-free wrt React: nothing here is hook-bound, watches survive
 * navigation, and the public surface is `watchTopUpFinality` +
 * `resumePendingTopUpWatches`.
 */

"use client";

import { createPaymentManager } from "@novasamatech/host-api-wrapper";
import {
  getSalesAwaitingClaimFinality,
  markSaleFinalized,
  markSaleReverted,
  recordSaleClaimShortfall,
} from "@/lib/storage";
import { captureWarning } from "@/lib/telemetry";
import {
  awaitTopUpStatus,
  isFinalTopUpStatus,
  topUpIdFromHex,
  type ClaimHost,
  type FinalTopUpStatus,
} from "./claim";

export interface TopUpWatchTarget {
  saleId: string;
  /** Hex of the host's top-up registration id, as stored on the sale. */
  topUpIdHex: string;
}

export interface TopUpWatcherDeps {
  host: Pick<ClaimHost, "subscribeTopUpStatus">;
  markSaleFinalized: (saleId: string) => Promise<void>;
  recordSaleClaimShortfall: (saleId: string, creditedPlanck: bigint) => Promise<void>;
  markSaleReverted: (saleId: string) => Promise<void>;
  getSalesAwaitingClaimFinality: () => Promise<TopUpWatchTarget[]>;
  sleep?: (ms: number) => Promise<void>;
  /** How long one watch stays armed before it is dropped (resumed on the next launch). */
  ttlMs?: number;
  /** Re-subscribes allowed when the host drops the subscription (NotFound excluded). */
  maxResubscribes?: number;
  backoffMs?: number;
}

const WATCH_TTL_MS = 60 * 60 * 1000;
const WATCH_BACKOFF_MS = 5_000;
const WATCH_MAX_RESUBSCRIBES = 5;

function log(message: string): void {
  console.log(`[TopUpWatcher] ${message}`);
}

const defaultDeps = (): TopUpWatcherDeps => {
  const manager = createPaymentManager();
  return {
    host: { subscribeTopUpStatus: (id, cb) => manager.subscribeTopUpStatus(id, cb) },
    markSaleFinalized: (saleId) => markSaleFinalized(saleId),
    recordSaleClaimShortfall,
    markSaleReverted,
    getSalesAwaitingClaimFinality,
  };
};

// Keyed by saleId — one watch per sale, however many callers ask.
const active = new Map<string, AbortController>();

/** For tests. */
export function activeTopUpWatchCount(): number {
  return active.size;
}

function isNotFound(payload: unknown): boolean {
  const name =
    payload instanceof Error
      ? payload.name
      : payload && typeof payload === "object"
        ? String((payload as { tag?: unknown; name?: unknown }).tag ?? (payload as { name?: unknown }).name ?? "")
        : "";
  return /NotFound/i.test(name);
}

async function applyFinal(
  target: TopUpWatchTarget,
  status: FinalTopUpStatus,
  deps: TopUpWatcherDeps,
): Promise<void> {
  switch (status.type) {
    case "claimed":
      log(`${target.saleId}: claim finalized`);
      await deps.markSaleFinalized(target.saleId);
      return;
    case "claimedPartially":
      log(`${target.saleId}: claim settled partially, credited ${status.actualClaimed}`);
      captureWarning("coins claim settled partially after the sale was recorded", {
        saleId: target.saleId,
        credited: status.actualClaimed.toString(),
      });
      await deps.recordSaleClaimShortfall(target.saleId, status.actualClaimed);
      return;
    case "notClaimed":
      log(`${target.saleId}: claim reverted — nothing landed`);
      captureWarning("coins claim reverted after the sale was recorded", { saleId: target.saleId });
      await deps.markSaleReverted(target.saleId);
      return;
  }
}

/**
 * Follow `target` until a terminal status and write it to the sale. Returns
 * when the watch ends (final status, abort, TTL, or too many drops). Exposed
 * for tests; app code uses `watchTopUpFinality`.
 */
export async function runTopUpWatch(
  target: TopUpWatchTarget,
  deps: TopUpWatcherDeps,
  signal: AbortSignal,
): Promise<"final" | "aborted" | "dropped"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxResubscribes = deps.maxResubscribes ?? WATCH_MAX_RESUBSCRIBES;
  const backoffMs = deps.backoffMs ?? WATCH_BACKOFF_MS;
  const id = topUpIdFromHex(target.topUpIdHex);

  for (let resubscribe = 0; ; resubscribe++) {
    try {
      const final = await awaitTopUpStatus(deps.host, id, isFinalTopUpStatus, signal);
      await applyFinal(target, final, deps);
      return "final";
    } catch (error) {
      if (signal.aborted) return "aborted";
      const payload = (error as { payload?: unknown })?.payload;
      if (isNotFound(payload)) {
        // The host has no record of this registration — nothing to follow.
        // Leave the sale "confirming"; a later launch tries again.
        log(`${target.saleId}: host does not know this top-up — leaving it confirming`);
        captureWarning("coins claim watch: host does not know the top-up id", { saleId: target.saleId });
        return "dropped";
      }
      if (resubscribe >= maxResubscribes) {
        log(`${target.saleId}: subscription dropped ${resubscribe + 1}× — giving up until the next launch`);
        return "dropped";
      }
      log(`${target.saleId}: subscription dropped (${String(error)}) — re-subscribing`);
      await sleep(backoffMs);
      if (signal.aborted) return "aborted";
    }
  }
}

/**
 * Follow a recorded sale's claim to its last word. Idempotent per `saleId`.
 */
export function watchTopUpFinality(target: TopUpWatchTarget, deps: TopUpWatcherDeps = defaultDeps()): void {
  if (active.has(target.saleId)) return;
  const abort = new AbortController();
  active.set(target.saleId, abort);
  const ttl = setTimeout(() => {
    log(`${target.saleId}: watch expired — will resume on the next launch`);
    abort.abort();
  }, deps.ttlMs ?? WATCH_TTL_MS);

  void runTopUpWatch(target, deps, abort.signal)
    .catch((err) => {
      console.warn(`[TopUpWatcher] ${target.saleId}: watch failed:`, err);
    })
    .finally(() => {
      clearTimeout(ttl);
      if (active.get(target.saleId) === abort) active.delete(target.saleId);
    });
}

/** Re-arm watches for every sale still confirming. Call once the host is connected. */
export async function resumePendingTopUpWatches(deps: TopUpWatcherDeps = defaultDeps()): Promise<number> {
  const pending = await deps.getSalesAwaitingClaimFinality();
  for (const target of pending) watchTopUpFinality(target, deps);
  if (pending.length > 0) log(`resumed ${pending.length} claim watch(es)`);
  return pending.length;
}

/** For tests: drop every active watch. */
export function stopAllTopUpWatches(): void {
  for (const abort of active.values()) abort.abort();
  active.clear();
}
