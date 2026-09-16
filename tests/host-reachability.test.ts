import { afterEach, describe, expect, it, vi } from "vitest";
import { isHostPaymentsReachable, type HostBalanceSubscription } from "@/lib/payments/host-reachability";
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
