import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitHostRuntime,
  detectHostEnvironment,
  isInHost,
  isTruApiRuntime,
  onTruApi,
  resetHostRuntime,
} from "@/lib/host/detect";

/**
 * The terminal carries two host clients for two incompatible wire codecs and
 * must pick exactly one per launch. `awaitHostRuntime()` makes that choice
 * once, waiting for a bootstrap that lands late, and every host module
 * follows it through `onTruApi()`.
 */

type Win = Record<string, unknown>;

const g = globalThis as { window?: unknown };
const original = g.window;

/** A stand-in window inside a host: an iframe-less webview with the mark. */
function hostWindow(extra: Win = {}): Win {
  const listeners: Record<string, () => void> = {};
  const win: Win = {
    __HOST_WEBVIEW_MARK__: true,
    __HOST_API_PORT__: {},
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
    removeEventListener: () => {},
    __fire: (name: string) => listeners[name]?.(),
    ...extra,
  };
  win.top = win;
  return win;
}

beforeEach(() => resetHostRuntime());
afterEach(() => {
  vi.useRealTimers();
  if (original === undefined) delete g.window;
  else g.window = original;
});

describe("awaitHostRuntime", () => {
  it("calls it TrUAPI on the strength of the published client alone", async () => {
    g.window = hostWindow({ __HOST_API_CLIENT__: { client: {} }, __truapi_localhost: undefined });
    expect(isTruApiRuntime()).toBe(true);
    expect(await awaitHostRuntime()).toBe("truapi");
    expect(await onTruApi()).toBe(true);
  });

  it("recognises the native container at once", async () => {
    g.window = hostWindow({ __container_callback__: () => {} });
    expect(await awaitHostRuntime()).toBe("native");
    expect(await onTruApi()).toBe(false);
  });

  it("waits for a TrUAPI bootstrap that lands late, and every caller gets the same answer", async () => {
    vi.useFakeTimers();
    const win = hostWindow();
    g.window = win;
    const first = awaitHostRuntime();
    const second = onTruApi();
    // Android registers the bootstrap after the page's own scripts…
    win.__HOST_API_CLIENT__ = { client: {} };
    (win.__fire as (n: string) => void)("truapi-native-ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe("truapi");
    expect(await second).toBe(true);
    // …and the decision sticks for the rest of the launch.
    delete win.__HOST_API_CLIENT__;
    expect(await awaitHostRuntime()).toBe("truapi");
  });

  it("falls back to the native container when neither runtime identifies itself", async () => {
    vi.useFakeTimers();
    g.window = hostWindow();
    const decided = awaitHostRuntime();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await decided).toBe("native");
  });

  it("answers native at once inside an iframe, where no marker can arrive", async () => {
    vi.useFakeTimers();
    const frame: Win = { addEventListener: () => {}, removeEventListener: () => {} };
    frame.top = {};
    g.window = frame;
    expect(isInHost()).toBe(true);
    let decided: string | null = null;
    void awaitHostRuntime().then((r) => (decided = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(decided).toBe("native");
  });

  it("is never TrUAPI outside a host", async () => {
    const tab: Win = {};
    tab.top = tab;
    g.window = tab;
    expect(isInHost()).toBe(false);
    expect(await onTruApi()).toBe(false);
  });
});

describe("detectHostEnvironment", () => {
  it("tells a webview from a plain browser tab", () => {
    g.window = hostWindow({ __HOST_API_CLIENT__: { client: {} } });
    expect(isInHost()).toBe(true);
    expect(detectHostEnvironment()).toBe("desktop-webview");

    const tab: Win = {};
    tab.top = tab;
    g.window = tab;
    expect(detectHostEnvironment()).toBe("standalone");
  });
});
