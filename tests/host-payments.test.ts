import { PaymentTopUpErr } from "@novasamatech/host-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/host/payments.ts bridges the two host clients onto one payments
 * contract. The codec-1 half is today's behaviour; these tests pin the TrUAPI
 * half, which talks to the client's payment calls directly (core ≥ 0.26,
 * trinity-user-agents #1314) and has to read like codec 1 to claim.ts and
 * the finality watcher:
 *
 *  - statuses map one for one onto the codec-1 events;
 *  - refusals become the codec-1 errors claim.ts branches on (AlreadyExists,
 *    SourceBusy, InvalidSource), and a forgotten top-up reads as NotFound;
 *  - a core without the payment bridge is reported as unsupported instead of
 *    being sent calls it cannot decode.
 */

type Observer = { next?: (item: unknown) => void; error?: (reason: unknown) => void; complete?: () => void };

/** A client observable the test drives by hand. */
function stream() {
  const observers: Observer[] = [];
  const unsubscribe = vi.fn();
  return {
    observable: {
      subscribe(observer: Observer) {
        observers.push(observer);
        return { unsubscribe };
      },
    },
    next: (item: unknown) => observers.forEach((o) => o.next?.(item)),
    error: (reason: unknown) => observers.forEach((o) => o.error?.(reason)),
    complete: () => observers.forEach((o) => o.complete?.()),
    unsubscribe,
  };
}

const ok = () => ({ isErr: () => false, value: undefined });
const err = (error: unknown) => ({ isErr: () => true, error });
const domain = (tag: string) => ({ tag: "Domain", value: { tag: "V1", value: { tag } } });

const truapi = vi.hoisted(() => ({ on: true }));
const client = vi.hoisted(() => ({
  current: null as null | { payment: Record<string, unknown> },
}));
const store = vi.hoisted(() => ({ subscribe: vi.fn() }));
const sdk = vi.hoisted(() => ({
  getStatementStore: vi.fn(async () => store),
  deriveEntropy: vi.fn(),
}));

vi.mock("@/lib/host/detect", () => ({ isTruApiRuntime: () => truapi.on }));
vi.mock("@/lib/host/sdk", () => ({
  loadHostSdk: async () => sdk,
  getTruApiClient: async () => client.current,
}));
vi.mock("@/lib/telemetry", () => ({ captureWarning: vi.fn() }));

const {
  createClaimHost,
  deferredSubscription,
  deriveHostEntropy,
  hostPaymentsAvailable,
  PaymentsUnsupportedError,
  subscribeHostBalance,
  subscribeHostStatements,
} = await import("@/lib/host/payments");
const { claimCoins, deriveTopUpId, NotClaimedError } = await import("@/lib/payments/coinage/claim");
const { runTopUpWatch } = await import("@/lib/payments/coinage/topup-watcher");
const { isPaymentsUnsupported } = await import("@/lib/payments/host-reachability");

const passthrough = <T,>(call: () => Promise<T>) => call();
const tick = () => new Promise((r) => setTimeout(r, 0));
const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

let payment: {
  topUp: ReturnType<typeof vi.fn>;
  topUpStatusSubscribe: ReturnType<typeof vi.fn>;
  balanceSubscribe: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  truapi.on = true;
  payment = { topUp: vi.fn(async () => ok()), topUpStatusSubscribe: vi.fn(), balanceSubscribe: vi.fn() };
  client.current = { payment };
  store.subscribe.mockReset();
  sdk.deriveEntropy.mockReset();
});

/** Claim with `statuses` scripted, one stream per subscription, emitted after subscribe. */
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

describe("the TrUAPI claim host", () => {
  it("registers the claim under its id, with the coins as hex sr25519 keys", async () => {
    const host = await createClaimHost(passthrough);
    const id = deriveTopUpId("pay-1", 1);
    await host.topUp(5_000_000n, [new Uint8Array([1, 2]), new Uint8Array([0xab])], id);
    expect(payment.topUp).toHaveBeenCalledWith({
      amount: 5_000_000n,
      source: { tag: "Coins", value: { sr25519SecretKeys: ["0x0102", "0xab"] } },
      id: hex(id),
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
    payment.topUp.mockResolvedValueOnce(ok()).mockResolvedValueOnce(err(domain("AlreadyExists")));
    scriptStatuses(
      (s) => s.error({ tag: "HostFailure", value: { reason: "bridge restarted" } }),
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

  it("turns the host's refusals into the codec-1 errors claim.ts reads", async () => {
    const host = await createClaimHost(passthrough);
    const id = deriveTopUpId("pay-5", 1);
    const refusedWith = async (error: unknown) => {
      payment.topUp.mockResolvedValueOnce(err(error));
      return host.topUp(1n, [new Uint8Array([1])], id).catch((e: unknown) => e);
    };
    expect(await refusedWith(domain("InvalidSource"))).toBeInstanceOf(PaymentTopUpErr.InvalidSource);
    expect(await refusedWith(domain("SourceBusy"))).toBeInstanceOf(PaymentTopUpErr.SourceBusy);
    expect(await refusedWith(domain("AlreadyExists"))).toBeInstanceOf(PaymentTopUpErr.AlreadyExists);
    const zero = await refusedWith(domain("InvalidAmount"));
    expect(zero).toBeInstanceOf(PaymentTopUpErr.Unknown);
    expect(JSON.stringify((zero as { payload?: unknown }).payload)).toContain("InvalidAmount");
    expect(await refusedWith({ tag: "Unsupported" })).toBeInstanceOf(PaymentTopUpErr.Unknown);
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
    scriptStatuses((s) => s.error(domain("TopUpNotFound")));
    const host = await createClaimHost(passthrough);
    const verdict = await runTopUpWatch(
      { saleId: "sale-1", topUpIdHex: hex(deriveTopUpId("pay-7", 1)).slice(2) },
      {
        host,
        markSaleFinalized: vi.fn(),
        recordSaleClaimShortfall: vi.fn(),
        markSaleReverted: vi.fn(),
        getSalesAwaitingClaimFinality: vi.fn(),
        sleep: async () => {},
      },
      new AbortController().signal,
    );
    expect(verdict).toBe("dropped");
    expect(payment.topUpStatusSubscribe).toHaveBeenCalledTimes(1);
  });

  it("hands a refusal made inside subscribe to listeners that arrive afterwards", () => {
    payment.topUpStatusSubscribe.mockImplementation(() => ({
      subscribe(observer: Observer) {
        observer.error?.(domain("TopUpNotFound"));
        return { unsubscribe: vi.fn() };
      },
    }));
    return createClaimHost(passthrough).then((host) => {
      const sub = host.subscribeTopUpStatus(new Uint8Array(32), () => {});
      const payloads: unknown[] = [];
      sub.onInterrupt?.((p) => payloads.push(p));
      expect(payloads).toEqual([{ tag: "TopUpNotFound", reason: "TopUpNotFound" }]);
    });
  });
});

describe("a TrUAPI core without the payment bridge", () => {
  beforeEach(() => {
    // What the SDK's own codec-2 client offers: the old calls, no status stream.
    client.current = { payment: { topUp: vi.fn(), balanceSubscribe: vi.fn() } };
  });

  it("is reported as unsupported, and is sent nothing", async () => {
    expect(await hostPaymentsAvailable()).toBe(false);
    await expect(createClaimHost(passthrough)).rejects.toBeInstanceOf(PaymentsUnsupportedError);

    const payloads: unknown[] = [];
    subscribeHostBalance(() => {}).onInterrupt?.((p) => payloads.push(p));
    await tick();
    expect(payloads).toHaveLength(1);
    expect(isPaymentsUnsupported(payloads[0])).toBe(true);
    expect(client.current!.payment.balanceSubscribe).not.toHaveBeenCalled();
  });

  it("does not hold codec 1 back", async () => {
    truapi.on = false;
    expect(await hostPaymentsAvailable()).toBe(true);
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
    expect(payment.balanceSubscribe).toHaveBeenCalledWith({ request: {} });
    expect(seen).toEqual([42n]);
    sub.unsubscribe();
    s.next({ available: 43n });
    expect(seen).toEqual([42n]);
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("passes a withheld balance through as the core's own refusal", async () => {
    const s = stream();
    payment.balanceSubscribe.mockReturnValue(s.observable);
    const payloads: unknown[] = [];
    subscribeHostBalance(() => {}).onInterrupt?.((p) => payloads.push(p));
    await tick();
    s.error(domain("PermissionDenied"));
    expect(payloads).toEqual([domain("PermissionDenied")]);
  });

  it("asks for the topic as hex and hands payloads back as bytes", async () => {
    store.subscribe.mockImplementation((_filter: unknown, cb: (p: unknown) => void) => {
      cb({ isComplete: true, statements: [{ data: "0x0a0b" }, {}] });
      return { unsubscribe: vi.fn(), onInterrupt: vi.fn() };
    });
    const pages: Array<{ statements: Array<{ data?: Uint8Array }>; isComplete: boolean }> = [];
    subscribeHostStatements(new Uint8Array([0xde, 0xad]), (p) => pages.push(p));
    await tick();
    expect(store.subscribe.mock.calls[0][0]).toEqual({ matchAny: ["0xdead"] });
    expect(pages[0].isComplete).toBe(true);
    expect(Array.from(pages[0].statements[0].data!)).toEqual([0x0a, 0x0b]);
    expect(pages[0].statements[1].data).toBeUndefined();
  });

  it("returns host entropy, and null instead of throwing when the host refuses", async () => {
    sdk.deriveEntropy.mockResolvedValue({ ok: true, value: new Uint8Array([7, 7]) });
    expect(Array.from((await deriveHostEntropy(new Uint8Array(32)))!)).toEqual([7, 7]);
    sdk.deriveEntropy.mockResolvedValue({ ok: false, error: {} });
    expect(await deriveHostEntropy(new Uint8Array(32))).toBeNull();
    sdk.deriveEntropy.mockRejectedValue(new Error("down"));
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
