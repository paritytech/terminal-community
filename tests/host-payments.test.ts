import { PaymentTopUpErr } from "@novasamatech/host-api";
import { SubscriptionError } from "@parity/truapi";
import { setTruApiClient } from "@parity/product-sdk-host/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/host/payments.ts bridges the two host clients onto one payments
 * contract. On the TrUAPI runtime it goes through the real
 * `@parity/product-sdk-host` (`getPaymentManager`, `getStatementStore`,
 * `deriveEntropy`); these tests drive the SDK with a fake TrUAPI client that
 * answers the way the generated client does — results with `match`, and
 * interrupts as a `SubscriptionError` with the host's reason on `.reason`.
 * Claim.ts and the finality watcher must not be able to tell which client
 * answered:
 *
 *  - statuses map one for one onto the codec-1 events;
 *  - refusals become `TopUpRefusal` kinds on both clients;
 *  - a forgotten top-up reads as NotFound, so the watcher stops;
 *  - a core without the payment bridge is reported as unsupported.
 */

type Observer = { next?: (item: unknown) => void; error?: (reason: unknown) => void; complete?: () => void };

/** A client subscription the test drives by hand. */
function stream() {
  const observers: Observer[] = [];
  const unsubscribe = vi.fn();
  return {
    observable: {
      subscribe(observer: Observer) {
        observers.push(observer);
        return { unsubscribe, subscriptionId: "sub" };
      },
    },
    next: (item: unknown) => observers.forEach((o) => o.next?.(item)),
    /** The host interrupts with a typed reason, as the generated client reports it. */
    interrupt: (reason: unknown) =>
      observers.forEach((o) => o.error?.(new SubscriptionError("Subscription interrupted", { reason }))),
    complete: () => observers.forEach((o) => o.complete?.()),
    unsubscribe,
  };
}

/** The generated client's `ResultAsync`, as far as the SDK reads it. */
const ok = (value?: unknown) => ({
  match: async (onOk: (v: unknown) => unknown) => onOk(value),
});
const err = (error: unknown) => ({
  match: async (_onOk: unknown, onErr: (e: unknown) => unknown) => onErr(error),
});
const domain = (tag: string) => ({ tag: "Domain", value: { tag: "V1", value: { tag } } });

const truapi = vi.hoisted(() => ({ on: true }));
const codec1 = vi.hoisted(() => ({
  topUp: null as null | ((...args: unknown[]) => Promise<void>),
}));

vi.mock("@/lib/host/detect", () => ({ isTruApiRuntime: () => truapi.on }));
vi.mock("@novasamatech/host-api-wrapper", () => ({
  createPaymentManager: () => ({
    topUp: (...args: unknown[]) => codec1.topUp!(...args),
    subscribeTopUpStatus: vi.fn(),
    subscribeBalance: vi.fn(),
  }),
}));
vi.mock("@/lib/telemetry", () => ({ captureWarning: vi.fn() }));

const { deferredSubscription } = await import("@/lib/host/subscription");
const {
  createClaimHost,
  deriveHostEntropy,
  hostPaymentsAvailable,
  PaymentsUnsupportedError,
  subscribeHostBalance,
  subscribeHostStatements,
} = await import("@/lib/host/payments");
const { claimCoins, deriveTopUpId, NotClaimedError, TopUpRefusal } = await import("@/lib/payments/coinage/claim");
const { runTopUpWatch } = await import("@/lib/payments/coinage/topup-watcher");
const { isBalanceWithheld, isPaymentsUnsupported } = await import("@/lib/payments/host-reachability");

const passthrough = <T,>(call: () => Promise<T>) => call();
const tick = () => new Promise((r) => setTimeout(r, 0));
const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

let payment: Record<string, ReturnType<typeof vi.fn>>;
let statementStore: { subscribe: ReturnType<typeof vi.fn> };
let entropy: { derive: ReturnType<typeof vi.fn> };

function installClient(paymentCalls: Record<string, unknown> = payment) {
  setTruApiClient({ payment: paymentCalls, statementStore, entropy } as never);
}

beforeEach(() => {
  truapi.on = true;
  payment = {
    topUp: vi.fn(() => ok()),
    topUpStatusSubscribe: vi.fn(),
    balanceSubscribe: vi.fn(),
  };
  statementStore = { subscribe: vi.fn() };
  entropy = { derive: vi.fn() };
  installClient();
});

afterEach(() => setTruApiClient(null));

/** Script the status subscriptions, one stream each, emitted after subscribe. */
function scriptStatuses(...scripts: Array<(s: ReturnType<typeof stream>) => void>) {
  const streams: Array<ReturnType<typeof stream>> = [];
  payment.topUpStatusSubscribe.mockImplementation(() => {
    const s = stream();
    streams.push(s);
    const script = scripts[streams.length - 1];
    queueMicrotask(() => script?.(s));
    return s.observable;
  });
  return streams;
}

const watchDeps = (host: Awaited<ReturnType<typeof createClaimHost>>) => ({
  host,
  markSaleFinalized: vi.fn(),
  recordSaleClaimShortfall: vi.fn(),
  markSaleReverted: vi.fn(),
  getSalesAwaitingClaimFinality: vi.fn(),
  sleep: async () => {},
});

describe("the TrUAPI claim host", () => {
  it("registers the claim under its id, with the coins as hex sr25519 keys", async () => {
    const host = await createClaimHost(passthrough);
    const id = deriveTopUpId("pay-1", 1);
    await host.topUp(5_000_000n, [new Uint8Array([1, 2]), new Uint8Array([0xab])], id);
    expect(payment.topUp).toHaveBeenCalledWith({
      id: hex(id),
      into: undefined,
      amount: 5_000_000n,
      source: { tag: "Coins", value: { sr25519SecretKeys: ["0x0102", "0xab"] } },
    });
  });

  it("settles a claim through claim.ts unchanged, statuses mapped one for one", async () => {
    scriptStatuses((s) => {
      s.next({ tag: "Detecting" });
      s.next({ tag: "Claiming" });
      s.next({ tag: "Claimed", value: { finalized: false } });
    });
    const seen: string[] = [];
    const outcome = await claimCoins({
      host: await createClaimHost(passthrough),
      amountPlanck: 12_500_000n,
      keys: [new Uint8Array([1])],
      topUpId: (n) => deriveTopUpId("pay-2", n),
      onStatus: (s) => seen.push(s.type === "claimed" ? `claimed:${s.finalized}` : s.type),
      sleep: async () => {},
    });
    expect(outcome).toMatchObject({ kind: "claimed", finalized: false, creditedPlanck: 12_500_000n });
    expect(seen).toEqual(["detecting", "claiming", "claimed:false"]);
    expect(payment.topUpStatusSubscribe).toHaveBeenCalledWith({ request: { id: hex(deriveTopUpId("pay-2", 1)) } });
  });

  it("reports a partial claim with what was credited", async () => {
    scriptStatuses((s) => s.next({ tag: "ClaimedPartially", value: { actualClaimed: 7n } }));
    const outcome = await claimCoins({
      host: await createClaimHost(passthrough),
      amountPlanck: 10n,
      keys: [new Uint8Array([1])],
      topUpId: (n) => deriveTopUpId("pay-3", n),
      sleep: async () => {},
    });
    expect(outcome).toMatchObject({ kind: "partial", creditedPlanck: 7n, requestedPlanck: 10n });
  });

  it("after a dropped status, reads AlreadyExists as the registration it has and follows it", async () => {
    payment.topUp.mockReturnValueOnce(ok()).mockReturnValueOnce(err(domain("AlreadyExists")));
    scriptStatuses(
      (s) => s.interrupt({ tag: "HostFailure", value: { reason: "bridge restarted" } }),
      (s) => s.next({ tag: "Claimed", value: { finalized: true } }),
    );
    const outcome = await claimCoins({
      host: await createClaimHost(passthrough),
      amountPlanck: 3n,
      keys: [new Uint8Array([1])],
      topUpId: (n) => deriveTopUpId("pay-4", n),
      sleep: async () => {},
    });
    expect(outcome).toMatchObject({ kind: "claimed", finalized: true });
    expect(payment.topUp).toHaveBeenCalledTimes(2);
    expect(payment.topUp.mock.calls[1][0].id).toBe(payment.topUp.mock.calls[0][0].id);
  });

  it("turns the host's refusals into TopUpRefusal kinds", async () => {
    const host = await createClaimHost(passthrough);
    const id = deriveTopUpId("pay-5", 1);
    const refusedWith = async (error: unknown) => {
      payment.topUp.mockReturnValueOnce(err(error));
      return host.topUp(1n, [new Uint8Array([1])], id).catch((e: unknown) => e);
    };
    for (const kind of ["InvalidSource", "SourceBusy", "AlreadyExists"] as const) {
      const refusal = await refusedWith(domain(kind));
      expect(refusal).toBeInstanceOf(TopUpRefusal);
      expect(refusal).toMatchObject({ kind, name: `PaymentTopUpErr::${kind}` });
    }
    const zero = await refusedWith(domain("InvalidAmount"));
    expect(zero).toMatchObject({ kind: "Unknown", reason: "InvalidAmount" });
    expect(await refusedWith({ tag: "Unsupported" })).toMatchObject({ kind: "Unknown", reason: "Unsupported" });
  });

  it("ends a claim the host never took with NotClaimed", async () => {
    scriptStatuses((s) => s.next({ tag: "NotClaimed" }));
    await expect(
      claimCoins({
        host: await createClaimHost(passthrough),
        amountPlanck: 1n,
        keys: [new Uint8Array([1])],
        topUpId: (n) => deriveTopUpId("pay-6", n),
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(NotClaimedError);
  });

  it("lets the finality watcher stop on a top-up the host no longer knows", async () => {
    // The generated client wraps the host's TopUpNotFound in a SubscriptionError;
    // before the SDK path the watcher read it as "Unknown" and kept re-subscribing.
    scriptStatuses((s) => s.interrupt(domain("TopUpNotFound")));
    const host = await createClaimHost(passthrough);
    const verdict = await runTopUpWatch(
      { saleId: "sale-1", topUpIdHex: hex(deriveTopUpId("pay-7", 1)).slice(2) },
      watchDeps(host),
      new AbortController().signal,
    );
    expect(verdict).toBe("dropped");
    expect(payment.topUpStatusSubscribe).toHaveBeenCalledTimes(1);
  });

  it("hands a refusal made inside subscribe to every listener, including late ones", async () => {
    payment.topUpStatusSubscribe.mockImplementation(() => ({
      subscribe(observer: Observer) {
        observer.error?.(new SubscriptionError("Subscription interrupted", { reason: domain("TopUpNotFound") }));
        return { unsubscribe: vi.fn(), subscriptionId: "sub" };
      },
    }));
    const host = await createClaimHost(passthrough);
    const sub = host.subscribeTopUpStatus(new Uint8Array(32), () => {});
    const first: unknown[] = [];
    const second: unknown[] = [];
    sub.onInterrupt?.((p) => first.push(p));
    sub.onInterrupt?.((p) => second.push(p));
    expect(first).toEqual([{ tag: "TopUpNotFound", reason: "TopUpNotFound" }]);
    expect(second).toEqual(first);
  });

  it("reports a clean end of the status stream as Completed", async () => {
    const streams = scriptStatuses((st) => st.complete());
    const host = await createClaimHost(passthrough);
    const payloads: unknown[] = [];
    host.subscribeTopUpStatus(new Uint8Array(32), () => {}).onInterrupt?.((p) => payloads.push(p));
    await tick();
    expect(streams).toHaveLength(1);
    expect(payloads).toEqual([{ tag: "Completed" }]);
  });
});

describe("the codec-1 claim host", () => {
  beforeEach(() => {
    truapi.on = false;
  });

  it("turns the wrapper's PaymentTopUpErr into TopUpRefusal kinds", async () => {
    const host = await createClaimHost(passthrough);
    const refusedWith = async (error: unknown) => {
      codec1.topUp = () => Promise.reject(error);
      return host.topUp(1n, [new Uint8Array([1])], new Uint8Array(32)).catch((e: unknown) => e);
    };
    expect(await refusedWith(new PaymentTopUpErr.SourceBusy())).toMatchObject({ kind: "SourceBusy" });
    expect(await refusedWith(new PaymentTopUpErr.InvalidSource())).toMatchObject({ kind: "InvalidSource" });
    expect(await refusedWith(new PaymentTopUpErr.AlreadyExists())).toMatchObject({ kind: "AlreadyExists" });
    expect(await refusedWith(new PaymentTopUpErr.Unknown({ reason: "Detecting" }))).toMatchObject({
      kind: "Unknown",
      reason: "Detecting",
    });
    const dropped = new Error("bridge gone");
    expect(await refusedWith(dropped)).toBe(dropped);
  });

  it("is always available", async () => {
    expect(await hostPaymentsAvailable()).toBe(true);
  });
});

describe("a TrUAPI core without the payment bridge", () => {
  beforeEach(() => {
    // A core from before 0.26: the old calls, no status stream.
    installClient({ topUp: vi.fn(), balanceSubscribe: vi.fn() });
  });

  it("answers the status subscription as unsupported, and the watcher stops at once", async () => {
    const host = await createClaimHost(passthrough);
    const payloads: unknown[] = [];
    host.subscribeTopUpStatus(new Uint8Array(32), () => {}).onInterrupt?.((p) => payloads.push(p));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toBeInstanceOf(PaymentsUnsupportedError);
    expect(isPaymentsUnsupported(payloads[0])).toBe(true);

    const subscribeSpy = vi.spyOn(host, "subscribeTopUpStatus");
    const verdict = await runTopUpWatch(
      { saleId: "sale-2", topUpIdHex: hex(deriveTopUpId("pay-8", 1)).slice(2) },
      watchDeps(host),
      new AbortController().signal,
    );
    expect(verdict).toBe("dropped");
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("outside a host container", () => {
  it("has no payments on the TrUAPI runtime", async () => {
    setTruApiClient(null);
    expect(await hostPaymentsAvailable()).toBe(false);
    await expect(createClaimHost(passthrough)).rejects.toBeInstanceOf(PaymentsUnsupportedError);
  });
});

describe("balance, statements and entropy on TrUAPI", () => {
  it("forwards the balance as a bigint, and stops listening on unsubscribe", async () => {
    const s = stream();
    payment.balanceSubscribe.mockReturnValue(s.observable);
    const seen: bigint[] = [];
    const sub = subscribeHostBalance((p) => seen.push(p));
    await tick();
    s.next({ available: 42n });
    expect(payment.balanceSubscribe).toHaveBeenCalledWith({ request: { purse: undefined } });
    expect(seen).toEqual([42n]);
    sub.unsubscribe();
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("passes a withheld balance through as the core's own refusal", async () => {
    const s = stream();
    payment.balanceSubscribe.mockReturnValue(s.observable);
    const payloads: unknown[] = [];
    subscribeHostBalance(() => {}).onInterrupt?.((p) => payloads.push(p));
    await tick();
    s.interrupt(domain("PermissionDenied"));
    expect(payloads).toEqual([{ tag: "PermissionDenied" }]);
    expect(isBalanceWithheld(payloads[0])).toBe(true);
  });

  it("asks for the topic as hex and hands payloads back as bytes", async () => {
    const s = stream();
    statementStore.subscribe.mockReturnValue(s.observable);
    const pages: Array<{ statements: Array<{ data?: Uint8Array }>; isComplete: boolean }> = [];
    subscribeHostStatements(new Uint8Array([0xde, 0xad]), (p) => pages.push(p));
    await tick();
    s.next({ isComplete: true, statements: [{ data: "0x0a0b" }, {}] });
    expect(statementStore.subscribe).toHaveBeenCalledWith({ request: { tag: "MatchAny", value: ["0xdead"] } });
    expect(pages[0].isComplete).toBe(true);
    expect(Array.from(pages[0].statements[0].data!)).toEqual([0x0a, 0x0b]);
    expect(pages[0].statements[1].data).toBeUndefined();
  });

  it("returns host entropy, and null instead of throwing when the host refuses", async () => {
    entropy.derive.mockReturnValue(ok({ entropy: "0x0707" }));
    expect(Array.from((await deriveHostEntropy(new Uint8Array(32)))!)).toEqual([7, 7]);
    entropy.derive.mockReturnValue(err({ tag: "Unknown", value: { reason: "no" } }));
    expect(await deriveHostEntropy(new Uint8Array(32))).toBeNull();
    entropy.derive.mockImplementation(() => {
      throw new Error("down");
    });
    expect(await deriveHostEntropy(new Uint8Array(32))).toBeNull();
  });
});

describe("deferredSubscription", () => {
  it("honours an unsubscribe that races ahead of the real subscription", async () => {
    const real = { unsubscribe: vi.fn(), onInterrupt: vi.fn() };
    let resolve!: (s: typeof real) => void;
    const sub = deferredSubscription(() => new Promise((r) => (resolve = r)));
    sub.unsubscribe();
    resolve(real);
    await tick();
    expect(real.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("forwards early interrupt listeners, and reports a failed start through them", async () => {
    const real = { unsubscribe: vi.fn(), onInterrupt: vi.fn() };
    const cb = vi.fn();
    const ok = deferredSubscription(async () => real);
    ok.onInterrupt!(cb);
    await tick();
    expect(real.onInterrupt).toHaveBeenCalledWith(cb);

    const failed = vi.fn();
    const bad = deferredSubscription(async () => {
      throw new Error("no store");
    });
    bad.onInterrupt!(failed);
    await tick();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
