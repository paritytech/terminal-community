import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/telemetry writes to the local log only: errors, warnings, timings,
 * payment outcomes and journeys become console lines, which log-capture
 * mirrors into the buffer that Settings → Logs / Report a problem export.
 * Secrets registered with `registerSecret` never leave the device in that
 * export.
 */

import {
  captureError,
  captureWarning,
  isExpectedError,
  JourneyTracker,
  recordCoinagePaymentPhase,
  recordFinalizationLatency,
  recordPaymentOutcome,
  withSpan,
} from "@/lib/telemetry";
import { _clearSecretsForTest, registerSecret, scrubText } from "@/lib/telemetry/scrub";

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearSecretsForTest();
});

const lastLine = (spy: ReturnType<typeof vi.spyOn>) => String(spy.mock.calls.at(-1)?.[0]);

describe("isExpectedError", () => {
  it("classifies user/external causes as expected", () => {
    for (const m of [
      "Insufficient funds for this payment",
      "Payment cancelled by user",
      "Network offline — check your connection",
      "Terminal is not bound — scan an admin QR",
      "finalization_timeout",
    ]) {
      expect(isExpectedError(m)).toBe(true);
    }
  });

  it("classifies arbitrary bugs as unexpected", () => {
    expect(isExpectedError("Cannot read properties of undefined (reading 'foo')")).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
  });
});

describe("errors and warnings", () => {
  it("logs an error with its tags and extra", () => {
    const failure = new Error("storage: Unknown", { cause: { tag: "Unknown", value: { reason: "x" } } });
    captureError(failure, { component: "terminal" }, { saleId: "s1" });
    const [label, logged, fields] = error.mock.calls.at(-1)!;
    expect(label).toBe("[error]");
    // The error object itself, so the log keeps its stack.
    expect(logged).toBe(failure);
    expect(fields).toEqual({ component: "terminal", saleId: "s1", cause: { tag: "Unknown", value: { reason: "x" } } });
  });

  it("logs a warning and never throws", () => {
    expect(() => captureWarning("RPC reconnect", { attempt: 2 })).not.toThrow();
    expect(lastLine(warn)).toBe("[warning] RPC reconnect");
  });
});

describe("withSpan", () => {
  it("returns the value and logs the duration", async () => {
    expect(withSpan("sync-op", () => 7)).toBe(7);
    expect(lastLine(info)).toMatch(/^\[span\] sync-op ok in \d+ms$/);
    await expect(withSpan("async-op", async () => "done")).resolves.toBe("done");
    expect(lastLine(info)).toMatch(/^\[span\] async-op ok in \d+ms$/);
  });

  it("rethrows, sync and async, and logs the failure", async () => {
    expect(() =>
      withSpan("sync-op", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(lastLine(info)).toMatch(/sync-op failed/);
    await expect(withSpan("async-op", () => Promise.reject(new Error("later")))).rejects.toThrow("later");
    expect(lastLine(info)).toMatch(/async-op failed/);
  });
});

describe("payment measurements", () => {
  it("logs a success as info and a failure as a warning with its reason", () => {
    recordPaymentOutcome({ outcome: "success", method: "coins", saleId: "s1" });
    expect(lastLine(info)).toBe("[payment] success");
    recordPaymentOutcome({ outcome: "failure", method: "coins", reason: "declined" });
    expect(lastLine(warn)).toBe("[payment] failure");
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ reason: "declined", terminalId: "unbound" });
  });

  it("logs a coinage phase with its rounded latency", () => {
    vi.spyOn(performance, "now").mockReturnValue(5_000);
    recordCoinagePaymentPhase({ phase: "host_topup", startedAt: 5_000 - 1234.6, coinCount: 2 });
    expect(lastLine(info)).toBe("[payment.coinage] host_topup success in 1235ms");
    expect(info.mock.calls.at(-1)?.[1]).toEqual({ coinCount: 2 });
  });

  it("logs finality, or that the watch timed out", () => {
    recordFinalizationLatency({ saleId: "s1", latencyMs: 1200.4, finalized: true });
    expect(lastLine(info)).toBe("[payment.finalization] finalized after 1200ms");
    recordFinalizationLatency({ saleId: "s2", latencyMs: 9000, finalized: false });
    expect(lastLine(warn)).toBe("[payment.finalization] timed out after 9000ms");
  });
});

describe("journeys", () => {
  it("logs a clean completion as not sad, and markSad / fail as sad", () => {
    const tracker = new JourneyTracker<"a" | "b" | "c">();
    tracker.start("a");
    tracker.complete("a");
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ sad: false });

    tracker.start("b");
    tracker.markSad("b");
    tracker.complete("b");
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ sad: true });

    tracker.start("c");
    tracker.fail("c", "boom");
    expect(lastLine(info)).toMatch(/failed after \d+ms: boom/);
    expect(info.mock.calls.at(-1)?.[1]).toMatchObject({ sad: true });
  });
});

describe("secret redaction", () => {
  it("redacts registered secrets, and ignores ones too short to be safe", () => {
    registerSecret("hunter2-correct-horse");
    registerSecret("short");
    expect(scrubText("password=hunter2-correct-horse; mode=short")).toBe("password=[redacted]; mode=short");
  });

  it("applies to the exported log", async () => {
    vi.stubGlobal("window", { console, addEventListener: () => {} });
    try {
      const { clearCapturedLogs, formatLogsAsText, installLogCapture } = await import("@/lib/debug/log-capture");
      installLogCapture();
      clearCapturedLogs();
      registerSecret("hunter2-correct-horse");
      console.warn("report password is hunter2-correct-horse");
      const text = formatLogsAsText();
      expect(text).toContain("report password is [redacted]");
      expect(text).not.toContain("hunter2-correct-horse");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
