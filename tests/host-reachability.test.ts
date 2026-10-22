import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isHostPaymentsReachable,
  isPaymentsUnsupported,
  probeHostPayments,
  type HostBalanceSubscription,
} from "@/lib/payments/host-reachability";
import { isProductWebSocketBlocked } from "@/lib/host/detect";

function fakeHost(script: (onBalance: () => void, interrupt: (p: unknown) => void) => void) {
  const unsubscribe = vi.fn();
  const subscribeBalance = vi.fn((onBalance: () => void): HostBalanceSubscription => {
    let interruptCb: ((p: unknown) => void) | null = null;
    queueMicrotask(() => script(onBalance, (p) => interruptCb?.(p)));
    return {
      unsubscribe,
      onInterrupt: (cb) => {
        interruptCb = cb;
      },
    };
  });
  return { subscribeBalance, unsubscribe };
}

describe("isHostPaymentsReachable", () => {
  it("is reachable once the host pushes a balance, and releases the subscription", async () => {
    const h = fakeHost((onBalance) => onBalance());
    await expect(isHostPaymentsReachable(1000, { subscribeBalance: h.subscribeBalance })).resolves.toBe(true);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is unreachable when the host interrupts the subscription", async () => {
    const h = fakeHost((_onBalance, interrupt) => interrupt({ name: "PaymentBalanceErr::Unknown" }));
    await expect(isHostPaymentsReachable(1000, { subscribeBalance: h.subscribeBalance })).resolves.toBe(false);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is unreachable when no balance arrives before the timeout", async () => {
    const h = fakeHost(() => {});
    await expect(isHostPaymentsReachable(20, { subscribeBalance: h.subscribeBalance })).resolves.toBe(false);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is unreachable when subscribing throws, and short-circuits outside a host or offline", async () => {
    const throwing = vi.fn(() => {
      throw new Error("no transport");
    });
    await expect(isHostPaymentsReachable(1000, { subscribeBalance: throwing })).resolves.toBe(false);

    const h = fakeHost((onBalance) => onBalance());
    await expect(isHostPaymentsReachable(1000, { subscribeBalance: h.subscribeBalance, inHost: () => false })).resolves.toBe(false);
    await expect(isHostPaymentsReachable(1000, { subscribeBalance: h.subscribeBalance, online: () => false })).resolves.toBe(false);
    expect(h.subscribeBalance).not.toHaveBeenCalled();
  });
});

describe("probeHostPayments — why it failed", () => {
  it("reports 'unsupported' for a host without payments", async () => {
    // A core with the payment bridge but an app without one: the core's own answer.
    const unsupported = fakeHost((_onBalance, interrupt) => interrupt({ tag: "Unsupported" }));
    await expect(probeHostPayments(1000, { subscribeBalance: unsupported.subscribeBalance })).resolves.toBe(
      "unsupported",
    );
    // A core that predates the bridge: lib/host/payments refuses before asking.
    const stub = fakeHost((_onBalance, interrupt) =>
      interrupt(Object.assign(new Error("payments are not supported by this host runtime"), {
        name: "PaymentsUnsupportedError",
      })),
    );
    await expect(probeHostPayments(1000, { subscribeBalance: stub.subscribeBalance })).resolves.toBe("unsupported");
  });

  it("calls a withheld balance reachable: the bridge answered, and a claim needs no balance access", async () => {
    // Both shapes a refusal arrives in: the core's CallError straight off the
    // client, and the SDK's SubscriptionError carrying it as `reason`.
    const callError = { tag: "Domain", value: { tag: "V1", value: { tag: "PermissionDenied" } } };
    const wrapped = Object.assign(new Error("Subscription interrupted"), {
      name: "SubscriptionError",
      reason: callError,
    });
    for (const refusal of [callError, wrapped]) {
      const h = fakeHost((_onBalance, interrupt) => interrupt(refusal));
      await expect(probeHostPayments(1000, { subscribeBalance: h.subscribeBalance })).resolves.toBe("reachable");
      expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps a real drop and a timeout as 'offline'", async () => {
    const drop = fakeHost((_onBalance, interrupt) => interrupt({ name: "PaymentBalanceErr::Unknown" }));
    await expect(probeHostPayments(1000, { subscribeBalance: drop.subscribeBalance })).resolves.toBe("offline");
    const silent = fakeHost(() => {});
    await expect(probeHostPayments(20, { subscribeBalance: silent.subscribeBalance })).resolves.toBe("offline");
  });

  it("recognises the host's 'not supported' wording too, and no longer reads PermissionDenied as it", () => {
    expect(isPaymentsUnsupported({ reason: "Payments are not supported in dot.li" })).toBe(true);
    expect(isPaymentsUnsupported("Unsupported")).toBe(true);
    expect(isPaymentsUnsupported({ name: "PaymentBalanceErr::Unknown" })).toBe(false);
    expect(isPaymentsUnsupported({ tag: "Domain", value: { tag: "V1", value: { tag: "PermissionDenied" } } })).toBe(
      false,
    );
  });
});

describe("isProductWebSocketBlocked", () => {
  const g = globalThis as { window?: unknown; WebSocket?: unknown };
  const originalWindow = g.window;
  const originalWs = g.WebSocket;
  afterEach(() => {
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
    if (originalWs === undefined) delete g.WebSocket;
    else g.WebSocket = originalWs;
  });

  it("recognises the iOS container's blocking proxy", () => {
    g.window = {};
    g.WebSocket = class {
      constructor() {
        throw new TypeError("Network access is not allowed");
      }
    };
    expect(isProductWebSocketBlocked()).toBe(true);
  });

  it("treats a real WebSocket (SyntaxError on an invalid URL) as available", () => {
    g.window = {};
    g.WebSocket = class {
      constructor(url: string) {
        if (!/^wss?:\/\/.+/.test(url)) throw new SyntaxError(`The URL '${url}' is invalid.`);
      }
    };
    expect(isProductWebSocketBlocked()).toBe(false);
  });

  it("is false without a window", () => {
    delete g.window;
    expect(isProductWebSocketBlocked()).toBe(false);
  });
});
