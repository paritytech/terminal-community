/**
 * The merchant's Pocket card: today's and this week's sales, and the last few
 * sales, on a card in the Polkadot app's Pocket.
 *
 * Two executables of this product meet here, and nowhere else:
 *
 *   app     (the terminal) writes a small snapshot of its sales to product host
 *           storage whenever the sales change: lib/pocket/sync.tsx.
 *   worker  (pocket/worker.ts) reads that snapshot whenever the host puts the
 *           card on screen, and draws the face from it.
 *
 * Product host storage is the only thing the two share. They never run in the
 * same document, but both are scoped to this product.
 *
 * The snapshot keeps sales per local day rather than as finished totals,
 * because "today" and "this week" move while the app is closed: the worker
 * works them out against its own clock each time it draws, so the card reads
 * right the morning after without the app having run. The figures are the
 * Sales screen's (app/(shell)/home/sales/page.tsx): incoming sales that were
 * not reverted, summed in planck, with weeks starting on Monday.
 *
 * The face follows pocket-reciept's constraints: the host frames a product
 * card 234dp tall and clips it, only the top of a card shows in the Pocket
 * stack, colour is theme tokens only (hosts draw every face in Berlin Night),
 * there are five text presets and no ellipsis, so every string is cut here.
 *
 * ASCII only: bundled into the Pocket worker, which the host reads as Latin-1.
 */

import {
  background,
  box,
  column,
  fillHeight,
  fillWidth,
  height,
  paddingEach,
  row,
  spacer,
  text,
  type ColorToken,
  type RendererNode,
  type TypographyStyle,
} from "./nodes";

/** The card's id in the worker manifest's `pocket.cards` (bulletin-deploy.config.ts). */
export const CARD_ID = "merchant";
export const CARD_TITLE = "T3RMINAL";

/** Where the app writes the snapshot, as the host stores it (no prefix). */
export const SNAPSHOT_KEY = "pocket:merchant";
/** Written by the worker on every draw: the card is in Pocket, on hosts that cannot list cards. */
export const SEEN_KEY = "pocket:merchant:seen";

/** Days of sales the snapshot keeps: a whole week back from any day of it. */
export const SNAPSHOT_DAYS = 8;
/** The newest sales listed on the card. */
export const RECENT_SHOWN = 2;

/** The host frames a product card at 234dp tall and clips to it. */
export const CARD_HEIGHT = 234;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MerchantSnapshot {
  v: 1;
  /** Display symbol of the asset sales are taken in, e.g. "CASH". */
  symbol: string;
  /** Decimals of that asset: planck per unit is 10^decimals. */
  decimals: number;
  /** Sales per local calendar day, newest first, for the last SNAPSHOT_DAYS days that had any. */
  days: { day: string; planck: string; count: number }[];
  /** The newest sales, newest first. */
  recent: { at: number; planck: string }[];
  /** Incoming sales ever taken, so the card can tell "none yet" from "none today". */
  total: number;
  /** When the app wrote this. */
  updatedAt: number;
}

/** The part of a stored sale the card reads. `SaleRecord` (lib/storage/types.ts) has all of it. */
export interface CardSale {
  saleId: string;
  amountPlanck: string;
  timestamp: Date | string | number;
  type: "incoming" | "outgoing";
  revertedAt?: Date | string | number;
}

/** Local calendar day, as YYYY-MM-DD. */
export function dayKey(at: Date): string {
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${m}-${d}`;
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** Monday-based start of the week `at` is in, as the Sales screen counts it. */
export function startOfWeek(at: Date): Date {
  const d = startOfDay(at);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function planckOf(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * The snapshot for these sales: incoming, not reverted, once per sale id.
 * Malformed amounts are skipped, as the Sales screen skips them.
 */
export function buildSnapshot(
  sales: readonly CardSale[],
  o: { symbol: string; decimals: number; now?: Date },
): MerchantSnapshot {
  const now = o.now ?? new Date();
  const oldest = startOfDay(new Date(startOfDay(now).getTime() - (SNAPSHOT_DAYS - 1) * DAY_MS));
  const seen = new Set<string>();
  const days = new Map<string, { planck: bigint; count: number }>();
  const taken: { at: number; planck: bigint }[] = [];

  for (const sale of sales) {
    if (sale.type !== "incoming" || sale.revertedAt || seen.has(sale.saleId)) continue;
    const planck = planckOf(sale.amountPlanck);
    const at = new Date(sale.timestamp);
    if (planck === null || Number.isNaN(at.getTime())) continue;
    seen.add(sale.saleId);
    taken.push({ at: at.getTime(), planck });
    if (at >= oldest) {
      const key = dayKey(at);
      const bucket = days.get(key) ?? { planck: BigInt(0), count: 0 };
      bucket.planck += planck;
      bucket.count += 1;
      days.set(key, bucket);
    }
  }

  taken.sort((a, b) => b.at - a.at);
  return {
    v: 1,
    symbol: o.symbol,
    decimals: o.decimals,
    days: [...days]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([day, b]) => ({ day, planck: b.planck.toString(), count: b.count })),
    recent: taken.slice(0, RECENT_SHOWN).map((s) => ({ at: s.at, planck: s.planck.toString() })),
    total: taken.length,
    updatedAt: now.getTime(),
  };
}

/** A stored value is a snapshot this build can read; anything else is no snapshot. */
export function isSnapshot(value: unknown): value is MerchantSnapshot {
  const s = value as MerchantSnapshot | null;
  return (
    !!s &&
    typeof s === "object" &&
    s.v === 1 &&
    typeof s.symbol === "string" &&
    typeof s.decimals === "number" &&
    Array.isArray(s.days) &&
    Array.isArray(s.recent) &&
    typeof s.total === "number"
  );
}

export interface CardStats {
  symbol: string;
  decimals: number;
  today: { planck: bigint; count: number };
  week: { planck: bigint; count: number };
  recent: { at: number; planck: bigint }[];
  total: number;
}

/** What the card shows at `now`: the snapshot's days read against the worker's own clock. */
export function cardStats(snapshot: MerchantSnapshot, now = new Date()): CardStats {
  const today = dayKey(now);
  const weekStart = dayKey(startOfWeek(now));
  const stats: CardStats = {
    symbol: snapshot.symbol,
    decimals: snapshot.decimals,
    today: { planck: BigInt(0), count: 0 },
    week: { planck: BigInt(0), count: 0 },
    recent: [],
    total: snapshot.total,
  };
  for (const d of snapshot.days) {
    const planck = planckOf(d.planck);
    // A day after `today` only exists if the clock moved back; it belongs to no window shown.
    if (planck === null || d.day > today) continue;
    if (d.day === today) {
      stats.today.planck += planck;
      stats.today.count += d.count;
    }
    if (d.day >= weekStart) {
      stats.week.planck += planck;
      stats.week.count += d.count;
    }
  }
  for (const r of snapshot.recent) {
    const planck = planckOf(r.planck);
    if (planck !== null) stats.recent.push({ at: r.at, planck });
  }
  return stats;
}

/** Planck as a display amount: thousands separators and two decimals, rounded half up. */
export function formatAmount(planck: bigint, decimals: number): string {
  const negative = planck < BigInt(0);
  let units = negative ? -planck : planck;
  if (decimals > 2) {
    const step = BigInt(10) ** BigInt(decimals - 2);
    units = (units + step / BigInt(2)) / step;
  } else if (decimals < 2) {
    units *= BigInt(10) ** BigInt(2 - decimals);
  }
  const cents = units % BigInt(100);
  const whole = (units / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${cents.toString().padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a sale was taken, as short as its distance from now allows: "14:02", "Mon 14:02", "27 Oct". */
export function formatWhen(at: number, now = new Date()): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayKey(d) === dayKey(now)) return time;
  if (d >= startOfWeek(now) && d <= now) return `${WEEKDAYS[d.getDay()]} ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** At most `max` characters, so nothing reaches the host's clip. */
function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const salesLabel = (count: number) => (count === 1 ? "1 SALE" : `${count} SALES`);

// ---- the face ---------------------------------------------------------------

const SURFACE: ColorToken = "BgSurfaceContainer";

const line = (content: string, style: TypographyStyle, color: ColorToken = "FgPrimary"): RendererNode =>
  text(content, { style, color });

function spread(left: RendererNode, right: RendererNode): RendererNode {
  return row([left, right], { horizontalArrangement: "SpaceBetween", verticalAlignment: "Center", modifiers: [fillWidth()] });
}

function stat(label: string, value: string): RendererNode {
  return column([line(label, "BodySmallRegular", "FgSecondary"), line(value, "TitleMediumRegular")]);
}

function card(sections: RendererNode[]): RendererNode {
  return box(
    [
      column(
        [spread(line(CARD_TITLE, "TitleMediumRegular"), line("SALES", "BodySmallRegular", "FgTertiary")), ...sections],
        {
          verticalArrangement: "SpaceBetween",
          modifiers: [fillWidth(), fillHeight(), paddingEach({ top: 18, start: 20, end: 20, bottom: 18 })],
        },
      ),
    ],
    { modifiers: [fillWidth(), height(CARD_HEIGHT), background(SURFACE)] },
  );
}

/** The card for these figures. */
export function merchantFace(stats: CardStats, now = new Date()): RendererNode {
  if (stats.total === 0) return emptyFace();
  const symbol = cut(stats.symbol, 8);
  const today = `${formatAmount(stats.today.planck, stats.decimals)} ${symbol}`;
  const recent = stats.recent.slice(0, RECENT_SHOWN).map((sale) =>
    spread(
      line(formatWhen(sale.at, now), "BodySmallRegular", "FgSecondary"),
      line(`${formatAmount(sale.planck, stats.decimals)} ${symbol}`, "BodySmallRegular"),
    ),
  );
  return card([
    column(
      [
        line(stats.today.count > 0 ? `TODAY - ${salesLabel(stats.today.count)}` : "TODAY - NO SALES YET", "BodySmallRegular", "FgSecondary"),
        line(today, today.length > 16 ? "TitleMediumRegular" : "HeadlineLarge"),
      ],
      { modifiers: [fillWidth()] },
    ),
    row(
      [stat("THIS WEEK", formatAmount(stats.week.planck, stats.decimals)), stat("SALES THIS WEEK", String(stats.week.count))],
      { horizontalArrangement: "SpaceBetween", modifiers: [fillWidth()] },
    ),
    column(recent.length > 0 ? recent : [spacer({ height: 1 })], { modifiers: [fillWidth()] }),
  ]);
}

/** Before the first sale: what the card is for. */
export function emptyFace(): RendererNode {
  return card([
    column(
      [
        line("No sales yet", "HeadlineLarge"),
        spacer({ height: 4 }),
        line("Sales you take on T3RMINAL add up here, by day and by week.", "BodySmallRegular", "FgSecondary"),
      ],
      { modifiers: [fillWidth()] },
    ),
    spacer({ height: 1 }),
  ]);
}

/** The face the worker draws for a stored snapshot, or the empty card for none. */
export function faceFor(snapshot: MerchantSnapshot | null, now = new Date()): RendererNode {
  return snapshot ? merchantFace(cardStats(snapshot, now), now) : emptyFace();
}

/** Made-up figures for the add sheet's preview, before the worker has drawn anything. */
export function sampleStats(now = new Date()): CardStats {
  return {
    symbol: "CASH",
    decimals: 6,
    today: { planck: BigInt(184_500_000), count: 7 },
    week: { planck: BigInt(1_242_750_000), count: 41 },
    recent: [
      { at: now.getTime() - 12 * 60 * 1000, planck: BigInt(24_000_000) },
      { at: now.getTime() - 47 * 60 * 1000, planck: BigInt(8_500_000) },
    ],
    total: 41,
  };
}
