/**
 * Cash out hands the merchant's CASH to getcash: these pin the amount the
 * terminal offers (today's sales, capped by the purse, at getcash's 2-decimal
 * scale), the bounds it mirrors, and the deeplink getcash's withdrawal reads.
 */

import { describe, expect, it } from "vitest";

import {
  buildCashOutDeeplink,
  cashOutAmountString,
  checkCashOutAmount,
  floorToCashOutScale,
  parseCashOutInput,
  todaysCashOutPlanck,
} from "@/lib/payments/cash-out";

/** CASH → planck (6 decimals). */
const cash = (amount: number) => BigInt(Math.round(amount * 1_000_000));

describe("cash-out amount scale", () => {
  it("floors to whole cents, never rounding up past what the purse holds", () => {
    expect(floorToCashOutScale(cash(12.349999))).toBe(cash(12.34));
    expect(floorToCashOutScale(cash(0.009))).toBe(0n);
    expect(floorToCashOutScale(-5n)).toBe(0n);
  });

  it("writes getcash's amount string without trailing zeros", () => {
    expect(cashOutAmountString(cash(120.5))).toBe("120.5");
    expect(cashOutAmountString(cash(10))).toBe("10");
    expect(cashOutAmountString(cash(0.07))).toBe("0.07");
    expect(cashOutAmountString(cash(99.999999))).toBe("99.99");
  });
});

describe("parseCashOutInput", () => {
  it("reads plain amounts with up to two decimals, comma or dot", () => {
    expect(parseCashOutInput("25")).toBe(cash(25));
    expect(parseCashOutInput(" 25.5 ")).toBe(cash(25.5));
    expect(parseCashOutInput("25,05")).toBe(cash(25.05));
    expect(parseCashOutInput("25.")).toBe(cash(25));
  });

  it("refuses anything else", () => {
    expect(parseCashOutInput("")).toBeNull();
    expect(parseCashOutInput("1.234")).toBeNull();
    expect(parseCashOutInput("-3")).toBeNull();
    expect(parseCashOutInput("1e3")).toBeNull();
    expect(parseCashOutInput("abc")).toBeNull();
  });
});

describe("todaysCashOutPlanck", () => {
  it("offers today's sales when the purse covers them", () => {
    expect(todaysCashOutPlanck(cash(120.5), cash(500))).toBe(cash(120.5));
  });

  it("caps at the purse when some of it already left", () => {
    expect(todaysCashOutPlanck(cash(120.5), cash(80.123456))).toBe(cash(80.12));
  });

  it("offers nothing until the purse is known", () => {
    expect(todaysCashOutPlanck(cash(120.5), null)).toBeNull();
  });
});

describe("checkCashOutAmount", () => {
  it("mirrors getcash's bounds: 10 to 2,000 CASH", () => {
    expect(checkCashOutAmount(0n, cash(100))).toEqual({ kind: "empty" });
    expect(checkCashOutAmount(cash(9.99), cash(100))).toEqual({ kind: "below-minimum" });
    expect(checkCashOutAmount(cash(10), cash(100))).toEqual({ kind: "ok" });
    expect(checkCashOutAmount(cash(2000), cash(5000))).toEqual({ kind: "ok" });
    expect(checkCashOutAmount(cash(2000.01), cash(5000))).toEqual({ kind: "above-maximum" });
  });

  it("checks the purse last, and only once it is known", () => {
    expect(checkCashOutAmount(cash(50), cash(49.99))).toEqual({ kind: "above-balance" });
    expect(checkCashOutAmount(cash(50), null)).toEqual({ kind: "ok" });
  });
});

describe("buildCashOutDeeplink", () => {
  it("opens getcash's withdrawal hash route with the amount and route", () => {
    const link = buildCashOutDeeplink({ amountPlanck: cash(120.5), route: "bank" });
    expect(link).toBe("polkadot://getcash.paseo/#/withdraw?amount=120.5&route=bank");
  });

  it("targets another deployment when asked", () => {
    const link = buildCashOutDeeplink({ amountPlanck: cash(10), route: "crypto" }, "pr42-getcash.paseo");
    expect(link).toBe("polkadot://pr42-getcash.paseo/#/withdraw?amount=10&route=crypto");
  });
});
