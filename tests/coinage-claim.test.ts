import { describe, expect, it, vi } from "vitest";
import { PaymentTopUpErr } from "@novasamatech/host-api";
import {
  ClaimCancelledError,
  NotClaimedError,
  NothingClaimedError,
  StatusInterruptedError,
  TOP_UP_ID_BYTES,
  awaitSettledTopUpStatus,
  claimCoins,
  deriveTopUpId,
  isFinalTopUpStatus,
  isRetryableTopUpError,
  topUpIdFromHex,
  topUpIdToHex,
  type ClaimHost,
  type TopUpStatusEvent,
} from "@/lib/payments/coinage/claim";

const KEYS = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
const AMOUNT = 12_500_000n; // 12.50 with 6 decimals
const noSleep = async () => {};
const hex = topUpIdToHex;

/**
 * A scripted host. `registrations[i]` is what the i-th `topUp` does (resolve,
 * or throw the given error); `runs[i]` is the status sequence the i-th
 * subscription emits, asynchronously, one event per macrotask. A run may end
 * with `{ interrupt: payload }` to simulate the host dropping it.
 */
type Run = Array<TopUpStatusEvent | { interrupt: unknown }>;
export function scriptedHost(registrations: Array<undefined | Error>, runs: Run[]) {
  const topUp = vi.fn(async (_amount: bigint, _keys: Uint8Array[], _id: Uint8Array) => {
    const step = registrations.shift();
    if (step instanceof Error) throw step;
  });
  const subscribedIds: string[] = [];
  const unsubscribed: string[] = [];
  const subscribeTopUpStatus = vi.fn((id: Uint8Array, onStatus: (s: TopUpStatusEvent) => void) => {
    subscribedIds.push(hex(id));
    const run = runs.shift() ?? [];
    const handlers: { interrupt: ((payload: unknown) => void) | null } = { interrupt: null };
    let stopped = false;
    void (async () => {
      for (const step of run) {
        await new Promise((r) => setTimeout(r, 0));
        if (stopped) return;
        if ("interrupt" in step) handlers.interrupt?.(step.interrupt);
        else onStatus(step);
      }
    })();
    return {
      unsubscribe: () => {
        stopped = true;
        unsubscribed.push(hex(id));
      },
      onInterrupt: (cb: (payload: unknown) => void) => {
        handlers.interrupt = cb;
        return () => {};
      },
    };
  });
  const host: ClaimHost = { topUp, subscribeTopUpStatus };
  return { host, topUp, subscribeTopUpStatus, subscribedIds, unsubscribed };
}

const idFor = (attempt: number) => deriveTopUpId("pay-1234", attempt);

describe("top-up ids", () => {
  it("are 32 bytes, deterministic, distinct per attempt and per payment", () => {
    const a1 = deriveTopUpId("pay-1234", 1);
    expect(a1).toHaveLength(TOP_UP_ID_BYTES);
    expect(hex(deriveTopUpId("pay-1234", 1))).toBe(hex(a1));
    expect(hex(deriveTopUpId("pay-1234", 2))).not.toBe(hex(a1));
    expect(hex(deriveTopUpId("pay-9999", 1))).not.toBe(hex(a1));
    expect(() => deriveTopUpId("pay-1234", 0)).toThrow();
  });

  it("round-trip through the hex stored on the sale record", () => {
    const id = idFor(3);
    expect(topUpIdFromHex(hex(id))).toEqual(id);
    expect(topUpIdFromHex(`0x${hex(id)}`)).toEqual(id);
    expect(() => topUpIdFromHex("abc")).toThrow();
  });
});

describe("claimCoins (register once, follow until the sale settles)", () => {
  it("registers once and settles at the first claimed, reporting whether it was final", async () => {
    const h = scriptedHost([undefined], [[{ type: "detecting" }, { type: "claiming" }, { type: "claimed", finalized: false }]]);
    const statuses: string[] = [];
    const outcome = await claimCoins({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      sleep: noSleep,
      onStatus: (s) => statuses.push(s.type),
    });
    expect(outcome).toMatchObject({ kind: "claimed", finalized: false, creditedPlanck: AMOUNT, requestedPlanck: AMOUNT });
    expect(hex(outcome.topUpId)).toBe(hex(idFor(1)));
    expect(h.topUp).toHaveBeenCalledTimes(1);
    expect(h.topUp).toHaveBeenCalledWith(AMOUNT, KEYS, idFor(1));
    expect(statuses).toEqual(["detecting", "claiming", "claimed"]);
    // The claim call stops listening once the sale is settled — finality is
    // the watcher's job.
    expect(h.unsubscribed).toEqual([hex(idFor(1))]);
  });

  it("reports an already-finalized claim as such", async () => {
    const h = scriptedHost([undefined], [[{ type: "claimed", finalized: true }]]);
    const outcome = await claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome).toMatchObject({ kind: "claimed", finalized: true });
  });

  it("reports a partial credit as a result, not a failure", async () => {
    const h = scriptedHost([undefined], [[{ type: "claiming" }, { type: "claimedPartially", actualClaimed: 10_000_000n }]]);
    const outcome = await claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome).toMatchObject({ kind: "partial", creditedPlanck: 10_000_000n, requestedPlanck: AMOUNT });
  });

  it("does not re-register on its own: notClaimed is a failure for the merchant to retry", async () => {
    const h = scriptedHost([undefined], [[{ type: "detecting" }, { type: "notClaimed" }]]);
    await expect(
      claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep }),
    ).rejects.toBeInstanceOf(NotClaimedError);
    expect(h.topUp).toHaveBeenCalledTimes(1);
  });

  it("a manual retry registers under the next id", async () => {
    const h = scriptedHost([undefined], [[{ type: "claimed", finalized: false }]]);
    const outcome = await claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, attempt: 2, sleep: noSleep });
    expect(h.topUp).toHaveBeenCalledWith(AMOUNT, KEYS, idFor(2));
    expect(hex(outcome.topUpId)).toBe(hex(idFor(2)));
  });

  it("follows an already-registered id when the host answers AlreadyExists", async () => {
    const h = scriptedHost([new PaymentTopUpErr.AlreadyExists()], [[{ type: "claimed", finalized: false }]]);
    const outcome = await claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome.kind).toBe("claimed");
    expect(h.subscribedIds).toEqual([hex(idFor(1))]);
  });

  it("follows the previous registration when a retry hits SourceBusy", async () => {
    const h = scriptedHost([new PaymentTopUpErr.SourceBusy()], [[{ type: "claimed", finalized: false }]]);
    const outcome = await claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, attempt: 2, sleep: noSleep });
    expect(outcome.kind).toBe("claimed");
    expect(h.subscribedIds).toEqual([hex(idFor(1))]);
  });

  it("re-registers the same id and re-subscribes when the host drops the status subscription", async () => {
    const h = scriptedHost(
      [undefined, new PaymentTopUpErr.AlreadyExists()],
      [[{ type: "detecting" }, { interrupt: { name: "PaymentTopUpStatusErr::Unknown" } }], [{ type: "claimed", finalized: false }]],
    );
    const drops: unknown[] = [];
    const outcome = await claimCoins({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      sleep: noSleep,
      onResubscribe: (_n, err) => drops.push(err),
    });
    expect(outcome.kind).toBe("claimed");
    expect(drops[0]).toBeInstanceOf(StatusInterruptedError);
    expect(h.topUp).toHaveBeenCalledTimes(2);
    expect(h.topUp.mock.calls.map((c) => hex(c[2]))).toEqual([hex(idFor(1)), hex(idFor(1))]);
    expect(h.subscribedIds).toEqual([hex(idFor(1)), hex(idFor(1))]);
  });

  it("gives up re-subscribing after maxResubscribes", async () => {
    const drop: Run = [{ interrupt: { name: "PaymentTopUpStatusErr::Unknown" } }];
    const h = scriptedHost([undefined, undefined, undefined], [drop, drop, drop]);
    await expect(
      claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, maxResubscribes: 2, sleep: noSleep }),
    ).rejects.toBeInstanceOf(StatusInterruptedError);
    expect(h.subscribeTopUpStatus).toHaveBeenCalledTimes(3);
  });

  it("does not retry InvalidSource and never subscribes", async () => {
    const refusal = new PaymentTopUpErr.InvalidSource();
    const h = scriptedHost([refusal], []);
    await expect(claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep })).rejects.toBe(refusal);
    expect(h.subscribeTopUpStatus).not.toHaveBeenCalled();
  });

  it("treats a partial claim that credited nothing as nothing claimed", async () => {
    const h = scriptedHost([undefined], [[{ type: "claimedPartially", actualClaimed: 0n }]]);
    await expect(claimCoins({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep })).rejects.toBeInstanceOf(
      NothingClaimedError,
    );
  });

  it("stops and unsubscribes when the sale is cancelled mid-claim", async () => {
    const h = scriptedHost([undefined], [[{ type: "detecting" }, { type: "detecting" }, { type: "detecting" }]]);
    const abort = new AbortController();
    const pending = claimCoins({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      signal: abort.signal,
      sleep: noSleep,
      onStatus: () => abort.abort(),
    });
    await expect(pending).rejects.toBeInstanceOf(ClaimCancelledError);
    expect(h.unsubscribed).toEqual([hex(idFor(1))]);
  });
});

describe("status helpers", () => {
  it("only finalized claims, partial claims and notClaimed are final", () => {
    expect(isFinalTopUpStatus({ type: "detecting" })).toBe(false);
    expect(isFinalTopUpStatus({ type: "claiming" })).toBe(false);
    expect(isFinalTopUpStatus({ type: "claimed", finalized: false })).toBe(false);
    expect(isFinalTopUpStatus({ type: "claimed", finalized: true })).toBe(true);
    expect(isFinalTopUpStatus({ type: "claimedPartially", actualClaimed: 1n })).toBe(true);
    expect(isFinalTopUpStatus({ type: "notClaimed" })).toBe(true);
  });

  it("awaitSettledTopUpStatus rejects immediately when the signal is already aborted", async () => {
    const h = scriptedHost([], [[{ type: "claimed", finalized: true }]]);
    const abort = new AbortController();
    abort.abort();
    await expect(awaitSettledTopUpStatus(h.host, idFor(1), abort.signal)).rejects.toBeInstanceOf(ClaimCancelledError);
    expect(h.subscribeTopUpStatus).not.toHaveBeenCalled();
  });

  it("isRetryableTopUpError only rules out the host's typed refusal and our own cancellation", () => {
    expect(isRetryableTopUpError(new PaymentTopUpErr.Unknown({ reason: "boom" }))).toBe(true);
    expect(isRetryableTopUpError(new PaymentTopUpErr.InvalidSource())).toBe(false);
    expect(isRetryableTopUpError(new ClaimCancelledError())).toBe(false);
  });
});
