import { describe, expect, it } from "vitest";
import { classifyTopupError, describeTopupFailure } from "@/lib/payments/coinage/topup-error";
import {
  ClaimCancelledError,
  NotClaimedError,
  NothingClaimedError,
  StatusInterruptedError,
  TopUpRefusal,
} from "@/lib/payments/coinage/claim";

describe("classifyTopupError", () => {
  it("maps known host shapes to stable kinds", () => {
    expect(classifyTopupError(new Error("request timed out"))).toBe("timeout");
    expect(classifyTopupError({ tag: "Declined", value: { reason: "insufficient" } })).toBe("declined");
    expect(classifyTopupError(new Error("host bridge unavailable"))).toBe("host");
    expect(classifyTopupError(new Error("weird"))).toBe("unknown");
  });

  it("reads the host's typed refusals", () => {
    expect(classifyTopupError(new TopUpRefusal("InvalidSource"))).toBe("invalid_source");
    expect(classifyTopupError(new TopUpRefusal("AlreadyExists"))).toBe("host");
    expect(classifyTopupError(new TopUpRefusal("SourceBusy"))).toBe("host");
    expect(
      classifyTopupError(new TopUpRefusal("Unknown", "Failed to move coins into the user's coin set: Detecting")),
    ).toBe("timeout");
    expect(classifyTopupError(new NotClaimedError(2))).toBe("not_claimed");
    expect(classifyTopupError(new NothingClaimedError())).toBe("not_claimed");
    expect(classifyTopupError(new StatusInterruptedError({ name: "PaymentTopUpStatusErr::NotFound" }))).toBe("timeout");
    expect(classifyTopupError(new ClaimCancelledError())).toBe("cancelled");
  });

  it("still understands the 0.9.x host's InsufficientFunds", () => {
    expect(classifyTopupError(new TopUpRefusal("InsufficientFunds"))).toBe("declined");
    const legacy = Object.assign(new Error("insufficient funds"), { name: "PaymentTopUpErr::InsufficientFunds" });
    expect(classifyTopupError(legacy)).toBe("declined");
  });
});

describe("describeTopupFailure", () => {
  it("has plain merchant wording for every kind, without host internals", () => {
    for (const kind of ["timeout", "not_claimed", "declined", "invalid_source", "host", "cancelled", "unknown"] as const) {
      const text = describeTopupFailure(kind);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/Detecting|NotClaimed|PaymentTopUpErr|coin set/);
    }
  });
});
