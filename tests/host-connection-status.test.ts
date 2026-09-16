import { afterEach, describe, expect, it } from "vitest";
import {
  describeHostConnectionFailure,
  type HostConnectionFailure,
} from "@/lib/host/connection-status";
import { isTruApiRuntime } from "@/lib/host/detect";

const REASONS: HostConnectionFailure[] = ["not-in-host", "truapi-runtime", "environment", "no-accounts", "error"];

describe("describeHostConnectionFailure", () => {
  it("has a title and body for every reason", () => {
    for (const reason of REASONS) {
      const copy = describeHostConnectionFailure(reason);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  it("tells the tester how to leave the TrUAPI runtime", () => {
    const copy = describeHostConnectionFailure("truapi-runtime");
    expect(copy.body).toMatch(/TrUAPI/);
    expect(copy.hint).toMatch(/Debug Settings/);
  });

  it("surfaces the thrown message for generic errors, with a fallback", () => {
    expect(describeHostConnectionFailure("error", "No webview port found").body).toBe("No webview port found");
    expect(describeHostConnectionFailure("error", "  ").body).toMatch(/Unexpected error/);
  });
});

describe("isTruApiRuntime", () => {
  const g = globalThis as { window?: unknown };
  const original = g.window;
  afterEach(() => {
    if (original === undefined) delete g.window;
    else g.window = original;
  });

  it("is false without a window or without the bootstrap marker", () => {
    delete g.window;
    expect(isTruApiRuntime()).toBe(false);
    g.window = { __HOST_WEBVIEW_MARK__: true, __HOST_API_PORT__: {} };
    expect(isTruApiRuntime()).toBe(false);
  });

  it("is true once the TrUAPI bootstrap published its ws-bridge endpoint", () => {
    g.window = { __truapi_localhost: { url: "ws://127.0.0.1:1/?t=x", token: "x" }, __HOST_WEBVIEW_MARK__: true };
    expect(isTruApiRuntime()).toBe(true);
  });
});
