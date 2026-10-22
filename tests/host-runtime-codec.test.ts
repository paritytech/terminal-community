import { afterEach, describe, expect, it } from "vitest";
import { HOST_RUNTIME_INIT_SCRIPT } from "@/lib/host/runtime-init";
import { detectHostEnvironment, isInHost, isTruApiRuntime } from "@/lib/host/detect";

/**
 * The terminal carries two host clients for two incompatible wire codecs, and
 * exactly one of them may claim `window.__HOST_API_PORT__`. The boot script is
 * what enforces that, by withholding the webview mark from the codec-1 client
 * on a TrUAPI launch. These tests pin both halves of that contract: what the
 * script does to the globals, and that our own detection still recognises the
 * host afterwards.
 */

type Win = Record<string, unknown>;

function runBootScript(win: Win): void {
  // The script is injected as inline `<head>` text, so it is evaluated, not
  // imported — run it the same way, against a stand-in window. It now also
  // watches for a late bootstrap, so the stand-in needs the two timer/listener
  // hooks it reaches for.
  win.addEventListener ??= () => {};
  win.removeEventListener ??= () => {};
  win.setInterval ??= () => 0;
  win.clearInterval ??= () => {};
  new Function("window", "setInterval", "clearInterval", HOST_RUNTIME_INIT_SCRIPT)(
    win,
    win.setInterval,
    win.clearInterval,
  );
}

const g = globalThis as { window?: unknown };
const original = g.window;
afterEach(() => {
  if (original === undefined) delete g.window;
  else g.window = original;
});

describe("the boot script's codec handover", () => {
  it("withholds the webview mark from the codec-1 client on a TrUAPI launch, and keeps it", () => {
    const win: Win = {
      __truapi_localhost: { url: "ws://127.0.0.1:1/?t=x" },
      __HOST_WEBVIEW_MARK__: true,
      __HOST_API_PORT__: {},
    };
    runBootScript(win);

    // The codec-1 wrapper tests exactly this and nothing else, so it now
    // reports "not a webview" and registers no port handlers.
    expect(win.__HOST_WEBVIEW_MARK__).toBeUndefined();
    // Nothing is lost: the mark moves rather than disappearing.
    expect(win.__T3R_HOST_WEBVIEW_MARK__).toBe(true);
    // The codec-2 client also accepts the port alone, so it still connects.
    expect(win.__HOST_API_PORT__).toBeDefined();
  });

  it("leaves a native-container launch untouched, and names it", () => {
    const win: Win = {
      __HOST_WEBVIEW_MARK__: true,
      __HOST_API_PORT__: {},
      // The native container installs this as it loads; it is what tells the
      // script the runtime is already settled and nothing is pending.
      __container_callback__: () => {},
    };
    runBootScript(win);
    expect(win.__HOST_WEBVIEW_MARK__).toBe(true);
    expect(win.__T3R_HOST_WEBVIEW_MARK__).toBeUndefined();
    expect(win.__T3R_HOST_RUNTIME__).toBe("native");
  });

  it("recognises the client newer cores publish, even with the old marker consumed", () => {
    // The lockdown container consumes `__truapi_localhost`, so it reads as
    // undefined while its key is still enumerable — the exact shape that made
    // a TrUAPI launch look native on device (2026-09-29).
    const win: Win = {
      __truapi_localhost: undefined,
      __HOST_API_CLIENT__: { client: {} },
      __HOST_WEBVIEW_MARK__: true,
      __HOST_API_PORT__: {},
    };
    runBootScript(win);
    expect(win.__HOST_WEBVIEW_MARK__).toBeUndefined();
    expect(win.__T3R_HOST_RUNTIME__).toBe("truapi");
  });

  it("still takes the mark when the bootstrap lands late", () => {
    // Android registers the bootstrap only once the TrUAPI execution opens, so
    // on a cold start neither global exists when this script runs.
    const listeners: Record<string, () => void> = {};
    const win: Win = {
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      removeEventListener: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    };
    runBootScript(win);
    expect(win.__T3R_HOST_RUNTIME__).toBeUndefined();

    // …then the host publishes its globals and fires its own event.
    win.__truapi_localhost = { url: "ws://127.0.0.1:1/?t=x" };
    win.__HOST_WEBVIEW_MARK__ = true;
    listeners["truapi-native-ready"]?.();

    expect(win.__HOST_WEBVIEW_MARK__).toBeUndefined();
    expect(win.__T3R_HOST_RUNTIME__).toBe("truapi");
  });

  it("does nothing outside a host", () => {
    const win: Win = {};
    expect(() => runBootScript(win)).not.toThrow();
    expect(win.__T3R_HOST_WEBVIEW_MARK__).toBeUndefined();
  });
});

describe("detection after the handover", () => {
  it("still sees a host, and still calls it a webview, once the mark has moved", () => {
    const win: Win = {
      __truapi_localhost: { url: "ws://127.0.0.1:1/?t=x" },
      __HOST_WEBVIEW_MARK__: true,
      __HOST_API_PORT__: {},
    };
    runBootScript(win);
    g.window = win;

    expect(isInHost()).toBe(true);
    expect(isTruApiRuntime()).toBe(true);
    // Reading the stashed mark is what keeps this "desktop-webview" rather
    // than being misread as an iframe.
    expect(detectHostEnvironment()).toBe("desktop-webview");
  });

  it("calls it TrUAPI on the strength of the published client alone", () => {
    g.window = { __HOST_API_CLIENT__: { client: {} }, __HOST_API_PORT__: {}, __truapi_localhost: undefined };
    expect(isInHost()).toBe(true);
    expect(isTruApiRuntime()).toBe(true);
  });

  it("recognises the native container, and a plain browser tab", () => {
    g.window = { __HOST_WEBVIEW_MARK__: true, __HOST_API_PORT__: {}, __container_callback__: () => {} };
    expect(isInHost()).toBe(true);
    expect(isTruApiRuntime()).toBe(false);
    expect(detectHostEnvironment()).toBe("desktop-webview");

    const tab: Win = {};
    (tab as { top?: unknown }).top = tab;
    g.window = tab;
    expect(isInHost()).toBe(false);
    expect(detectHostEnvironment()).toBe("standalone");
  });
});
