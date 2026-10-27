import { describe, expect, it } from "vitest";
import { androidLimits, validateFace } from "@parity/product-sdk-renderer";
import {
  SNAPSHOT_DAYS,
  buildSnapshot,
  cardStats,
  emptyFace,
  faceFor,
  formatAmount,
  formatWhen,
  isSnapshot,
  merchantFace,
  sampleStats,
  type CardSale,
  type CardStats,
} from "@/lib/pocket/merchant-card";

/**
 * The merchant Pocket card (lib/pocket/merchant-card.ts). What has to hold:
 *
 *  - the card counts what the Sales screen counts: incoming sales, not
 *    reverted, once per sale id, summed in planck, weeks starting on Monday;
 *  - "today" and "this week" come from the worker's clock at draw time, so
 *    the card is right the morning after without the app having run;
 *  - every face the worker can send is one the Android host accepts, and is
 *    ASCII (the host reads the worker as Latin-1).
 *
 * Dates are built in local time, as the card reads them, so the tests hold in
 * any timezone. 2026-10-28 is a Wednesday; that week starts Monday 26 Oct.
 */

const CASH = { symbol: "CASH", decimals: 6 };
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute);
const NOW = at(28, 15, 30);

let nextId = 0;
const sale = (when: Date, planck: string, extra: Partial<CardSale> = {}): CardSale => ({
  saleId: `sale-${++nextId}`,
  amountPlanck: planck,
  timestamp: when,
  type: "incoming",
  ...extra,
});

describe("the snapshot the app writes", () => {
  it("keeps incoming, unreverted sales once each, by local day, newest first", () => {
    const dup = sale(at(28, 9), "1000000");
    const snapshot = buildSnapshot(
      [
        sale(at(28, 14), "2500000"),
        dup,
        { ...dup },
        sale(at(27, 10), "4000000"),
        sale(at(28, 11), "9000000", { type: "outgoing" }),
        sale(at(28, 12), "7000000", { revertedAt: at(28, 13) }),
        sale(at(28, 13), "not-a-number"),
      ],
      { ...CASH, now: NOW },
    );
    expect(snapshot.days).toEqual([
      { day: "2026-10-28", planck: "3500000", count: 2 },
      { day: "2026-10-27", planck: "4000000", count: 1 },
    ]);
    expect(snapshot.recent.map((r) => r.planck)).toEqual(["2500000", "1000000"]);
    expect(snapshot.total).toBe(3);
    expect(isSnapshot(snapshot)).toBe(true);
  });

  it("drops days older than the window but still counts them in the total", () => {
    const old = at(28 - SNAPSHOT_DAYS, 12);
    const snapshot = buildSnapshot([sale(old, "1"), sale(at(28 - SNAPSHOT_DAYS + 1), "2")], { ...CASH, now: NOW });
    expect(snapshot.days.map((d) => d.day)).toEqual(["2026-10-21"]);
    expect(snapshot.total).toBe(2);
  });

  it("rejects anything that is not a snapshot this build can read", () => {
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot("")).toBe(false);
    expect(isSnapshot({ v: 2, symbol: "CASH", decimals: 6, days: [], recent: [], total: 0 })).toBe(false);
  });
});

describe("what the card shows", () => {
  const snapshot = buildSnapshot(
    [
      sale(at(28, 9), "1000000"),
      sale(at(28, 10), "2000000"),
      sale(at(26, 10), "3000000"), // Monday: this week
      sale(at(25, 10), "4000000"), // Sunday: last week
    ],
    { ...CASH, now: NOW },
  );

  it("sums today and the Monday-based week", () => {
    const stats = cardStats(snapshot, NOW);
    expect(stats.today).toEqual({ planck: BigInt(3000000), count: 2 });
    expect(stats.week).toEqual({ planck: BigInt(6000000), count: 3 });
  });

  it("moves on by itself: next day nothing is today, next Monday a new week starts", () => {
    expect(cardStats(snapshot, at(29, 8)).today.count).toBe(0);
    expect(cardStats(snapshot, at(29, 8)).week.count).toBe(3);
    expect(cardStats(snapshot, new Date(2026, 10, 2, 8)).week.count).toBe(0);
  });
});

describe("formatting", () => {
  it("shows two decimals with thousands separators, rounding half up", () => {
    expect(formatAmount(BigInt(1_234_565_000), 6)).toBe("1,234.57");
    expect(formatAmount(BigInt(1_234_564_999), 6)).toBe("1,234.56");
    expect(formatAmount(BigInt(0), 6)).toBe("0.00");
    expect(formatAmount(BigInt(5), 0)).toBe("5.00");
    // 999,999,999,999.999999 rounds up into the next thousand.
    expect(formatAmount(BigInt("999999999999999999"), 6)).toBe("1,000,000,000,000.00");
  });

  it("says when a sale was taken as briefly as it can", () => {
    expect(formatWhen(at(28, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(formatWhen(at(26, 18, 0).getTime(), NOW)).toBe("Mon 18:00");
    expect(formatWhen(at(25, 18, 0).getTime(), NOW)).toBe("25 Oct");
  });
});

describe("the face", () => {
  const huge = BigInt("999999999999999999");
  const faces: Array<[string, unknown]> = [
    ["empty", emptyFace()],
    ["sample", merchantFace(sampleStats(NOW), NOW)],
    ["nothing today", merchantFace({ ...sampleStats(NOW), today: { planck: BigInt(0), count: 0 } }, NOW)],
    ["huge", merchantFace({ ...sampleStats(NOW), today: { planck: huge, count: 99999 }, week: { planck: huge, count: 99999 } }, NOW)],
    ["long symbol", merchantFace({ ...sampleStats(NOW), symbol: "AVERYLONGASSETSYMBOL" }, NOW)],
    ["no snapshot", faceFor(null, NOW)],
  ];

  it.each(faces)("%s is accepted by the Android host and is ASCII", (_name, face) => {
    const json = JSON.stringify(face, null, 2);
    expect(validateFace(json, { host: androidLimits }).ok).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(json)).toBe(true);
  });

  it("shows the empty card before the first sale, and the figures after", () => {
    const empty = JSON.stringify(faceFor(buildSnapshot([], { ...CASH, now: NOW }), NOW));
    expect(empty).toContain("No sales yet");
    const stats: CardStats = cardStats(buildSnapshot([sale(at(28, 9), "12500000")], { ...CASH, now: NOW }), NOW);
    const face = JSON.stringify(merchantFace(stats, NOW));
    expect(face).toContain("TODAY - 1 SALE");
    expect(face).toContain("12.50 CASH");
    expect(face).toContain("09:00");
  });

  it("steps today's figure down to a smaller style when it would not fit", () => {
    const big = JSON.stringify(
      merchantFace({ ...sampleStats(NOW), today: { planck: BigInt("12345678900000000"), count: 1 } }, NOW),
    );
    expect(big).toContain("12,345,678,900.00 CASH");
    expect(big).not.toContain("HeadlineLarge");
  });
});
