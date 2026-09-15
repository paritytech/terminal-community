import { describe, expect, it, vi } from "vitest";
import { PaymentTopUpErr } from "@novasamatech/host-api";
import {
  ClaimCancelledError,
  NotClaimedError,
  NothingClaimedError,
  StatusInterruptedError,
  TOP_UP_ID_BYTES,
  awaitTerminalTopUpStatus,
  claimCoinsWithRetry,
  deriveTopUpId,
  isRetryableTopUpError,
  type ClaimHost,
  type TopUpStatusEvent,
} from "@/lib/payments/coinage/claim";

const KEYS = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
const AMOUNT = 12_500_000n; // 12.50 with 6 decimals
const noSleep = async () => {};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A scripted host. `registrations[i]` is what the i-th `topUp` does (resolve,
 * or throw the given error); `runs[i]` is the status sequence the i-th
 * subscription emits, asynchronously, one event per macrotask. A run may end
 * with `{ interrupt: payload }` to simulate the host dropping it.
 */
type Run = Array<TopUpStatusEvent | { interrupt: unknown }>;
function scriptedHost(registrations: Array<undefined | Error>, runs: Run[]) {
  const topUp = vi.fn(async (_amount: bigint, _keys: Uint8Array[], _id: Uint8Array) => {
    const step = registrations.shift();
    if (step instanceof Error) throw step;
  });
  const subscribedIds: string[] = [];
  const unsubscribed: string[] = [];
  const subscribeTopUpStatus = vi.fn((id: Uint8Array, onStatus: (s: TopUpStatusEvent) => void) => {
    subscribedIds.push(hex(id));
    const run = runs.shift() ?? [];
    // Held in an object so the async loop below sees the handler registered
    // after `subscribe` returns (a plain `let` narrows to `null` for TS).
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

describe("deriveTopUpId", () => {
  it("is 32 bytes, deterministic, and distinct per attempt and per payment", () => {
    const a1 = deriveTopUpId("pay-1234", 1);
    expect(a1).toHaveLength(TOP_UP_ID_BYTES);
    expect(hex(deriveTopUpId("pay-1234", 1))).toBe(hex(a1));
    expect(hex(deriveTopUpId("pay-1234", 2))).not.toBe(hex(a1));
    expect(hex(deriveTopUpId("pay-9999", 1))).not.toBe(hex(a1));
    expect(() => deriveTopUpId("pay-1234", 0)).toThrow();
  });
});

describe("claimCoinsWithRetry (register + follow status)", () => {
  it("registers once and resolves as claimed when the host reports claimed in a block", async () => {
    const h = scriptedHost([undefined], [[{ type: "detecting" }, { type: "claiming" }, { type: "claimed", finalized: false }]]);
    const statuses: string[] = [];
    const outcome = await claimCoinsWithRetry({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      sleep: noSleep,
      onStatus: (s) => statuses.push(s.type),
    });
    expect(outcome).toMatchObject({ kind: "claimed", creditedPlanck: AMOUNT, requestedPlanck: AMOUNT });
    expect(hex(outcome.topUpId)).toBe(hex(idFor(1)));
    expect(h.topUp).toHaveBeenCalledTimes(1);
    expect(h.topUp).toHaveBeenCalledWith(AMOUNT, KEYS, idFor(1));
    expect(statuses).toEqual(["detecting", "claiming", "claimed"]);
    // Nothing keeps listening once the claim is settled.
    expect(h.unsubscribed).toEqual([hex(idFor(1))]);
  });

  it("reports a partial credit as a result, not a failure", async () => {
    const h = scriptedHost([undefined], [[{ type: "claiming" }, { type: "claimedPartially", actualClaimed: 10_000_000n }]]);
    const outcome = await claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome).toMatchObject({ kind: "partial", creditedPlanck: 10_000_000n, requestedPlanck: AMOUNT });
    expect(h.topUp).toHaveBeenCalledTimes(1);
  });

  it("re-registers with a fresh id after notClaimed, and gives up with NotClaimedError when the attempts are used", async () => {
    const h = scriptedHost(
      [undefined, undefined, undefined],
      [[{ type: "notClaimed" }], [{ type: "notClaimed" }], [{ type: "notClaimed" }]],
    );
    const retried: number[] = [];
    await expect(
      claimCoinsWithRetry({
        host: h.host,
        amountPlanck: AMOUNT,
        keys: KEYS,
        topUpId: idFor,
        maxAttempts: 3,
        sleep: noSleep,
        onRetryableFailure: (attempt) => retried.push(attempt),
      }),
    ).rejects.toBeInstanceOf(NotClaimedError);
    expect(h.topUp).toHaveBeenCalledTimes(3);
    expect(h.subscribedIds).toEqual([hex(idFor(1)), hex(idFor(2)), hex(idFor(3))]);
    expect(retried).toEqual([1, 2]);
  });

  it("succeeds on a later registration once the payer's coins are on chain", async () => {
    const h = scriptedHost([undefined, undefined], [[{ type: "notClaimed" }], [{ type: "claimed", finalized: true }]]);
    const outcome = await claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome.kind).toBe("claimed");
    expect(hex(outcome.topUpId)).toBe(hex(idFor(2)));
  });

  it("continues the registration sequence from firstAttempt (manual retry)", async () => {
    const h = scriptedHost([undefined], [[{ type: "claimed", finalized: false }]]);
    const attempts: Array<[number, number, number]> = [];
    await claimCoinsWithRetry({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      firstAttempt: 4,
      sleep: noSleep,
      onAttempt: (i, max, attempt) => attempts.push([i, max, attempt]),
    });
    expect(h.subscribedIds).toEqual([hex(idFor(4))]);
    expect(attempts).toEqual([[1, 3, 4]]);
  });

  it("follows an already-registered id when the host answers AlreadyExists", async () => {
    const h = scriptedHost([new PaymentTopUpErr.AlreadyExists()], [[{ type: "claimed", finalized: false }]]);
    const outcome = await claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome.kind).toBe("claimed");
    expect(h.subscribedIds).toEqual([hex(idFor(1))]);
  });

  it("follows the previous registration when the host answers SourceBusy", async () => {
    // Registration 1 ends notClaimed but the host still considers the source
    // busy when registration 2 arrives — so we follow registration 1's id.
    const h = scriptedHost(
      [undefined, new PaymentTopUpErr.SourceBusy()],
      [[{ type: "notClaimed" }], [{ type: "claimed", finalized: false }]],
    );
    const outcome = await claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep });
    expect(outcome.kind).toBe("claimed");
    expect(h.subscribedIds).toEqual([hex(idFor(1)), hex(idFor(1))]);
  });

  it("re-registers when the host drops the status subscription", async () => {
    const h = scriptedHost(
      [undefined, undefined],
      [[{ type: "detecting" }, { interrupt: { name: "PaymentTopUpStatusErr::NotFound" } }], [{ type: "claimed", finalized: false }]],
    );
    const retried: unknown[] = [];
    const outcome = await claimCoinsWithRetry({
      host: h.host,
      amountPlanck: AMOUNT,
      keys: KEYS,
      topUpId: idFor,
      sleep: noSleep,
      onRetryableFailure: (_a, err) => retried.push(err),
    });
    expect(outcome.kind).toBe("claimed");
    expect(retried[0]).toBeInstanceOf(StatusInterruptedError);
    expect(h.topUp).toHaveBeenCalledTimes(2);
  });

  it("does not retry InvalidSource and never subscribes", async () => {
    const refusal = new PaymentTopUpErr.InvalidSource();
    const h = scriptedHost([refusal], []);
    await expect(
      claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, sleep: noSleep }),
    ).rejects.toBe(refusal);
    expect(h.topUp).toHaveBeenCalledTimes(1);
    expect(h.subscribeTopUpStatus).not.toHaveBeenCalled();
  });

  it("treats a partial claim that credited nothing as nothing claimed", async () => {
    const h = scriptedHost([undefined], [[{ type: "claimedPartially", actualClaimed: 0n }]]);
    await expect(
      claimCoinsWithRetry({ host: h.host, amountPlanck: AMOUNT, keys: KEYS, topUpId: idFor, maxAttempts: 1, sleep: noSleep }),
    ).rejects.toBeInstanceOf(NothingClaimedError);
  });

  it("stops and unsubscribes when the sale is cancelled mid-claim", async () => {
    const h = scriptedHost([undefined], [[{ type: "detecting" }, { type: "detecting" }, { type: "detecting" }]]);
    const abort = new AbortController();
    const pending = claimCoinsWithRetry({
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

describe("awaitTerminalTopUpStatus", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const h = scriptedHost([], [[{ type: "claimed", finalized: true }]]);
    const abort = new AbortController();
    abort.abort();
    await expect(awaitTerminalTopUpStatus(h.host, idFor(1), abort.signal)).rejects.toBeInstanceOf(ClaimCancelledError);
    expect(h.subscribeTopUpStatus).not.toHaveBeenCalled();
  });
});

describe("isRetryableTopUpError", () => {
  it("only rules out the host's typed refusal and our own cancellation", () => {
    expect(isRetryableTopUpError(new PaymentTopUpErr.Unknown({ reason: "boom" }))).toBe(true);
    expect(isRetryableTopUpError(new Error("bridge dropped"))).toBe(true);
    expect(isRetryableTopUpError(new PaymentTopUpErr.InvalidSource())).toBe(false);
    expect(isRetryableTopUpError(new ClaimCancelledError())).toBe(false);
  });
});
