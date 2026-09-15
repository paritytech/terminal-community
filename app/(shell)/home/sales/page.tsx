"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { SubpageHeader } from "@/components/subpage-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSalesHistory, type SaleRecord } from "@/lib/storage";
import { formatAmountFromPlanck } from "@/lib/utils/format";
import { PUSD_DECIMALS } from "@/lib/utils/asset-ids";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ChartView = "months" | "weeks" | "days";
const WEEKS_SHOWN = 12;
const DAYS_SHOWN = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Planck → display string with thousands separators, always 2 decimals. */
function money(planck: bigint): string {
  return Number(formatAmountFromPlanck(planck, PUSD_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Monday-based start of the current week. */
function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - day);
  return d;
}

/**
 * Sales dashboard, opened from the Home "Sales" tile. All figures are computed
 * from the local sale records (same source as History): incoming sales only,
 * summed in exact planck bigints and formatted once for display.
 *
 * Design system: stat cards are container surfaces with shadow-1; every
 * figure is Martian Mono; the chart's bars use the illustration fills (there
 * is no chart palette in the token set — see the gap register).
 */
export default function SalesPage() {
  const router = useRouter();
  const symbol = useAssetSymbol();
  const { sales, isLoading } = useSalesHistory();
  const currentYear = new Date().getFullYear();
  const [view, setView] = useState<ChartView>("months");
  // Tapped bar whose amount tooltip stays open (hover covers mouse users).
  const [activeBar, setActiveBar] = useState<number | null>(null);

  const stats = useMemo(() => {
    const incoming = (sales ?? []).filter((s: SaleRecord) => s.type === "incoming");
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let today = 0n;
    let week = 0n;
    let month = 0n;
    let total = 0n;
    let yearTotal = 0n;
    const monthly: bigint[] = Array.from({ length: 12 }, () => 0n);
    // Rolling buckets, oldest first — index (length-1) is the current week/day.
    const weekly: bigint[] = Array.from({ length: WEEKS_SHOWN }, () => 0n);
    const daily: bigint[] = Array.from({ length: DAYS_SHOWN }, () => 0n);

    for (const sale of incoming) {
      let amount: bigint;
      try {
        amount = BigInt(sale.amountPlanck);
      } catch {
        continue; // malformed legacy record — skip rather than poison the totals
      }
      const ts = new Date(sale.timestamp);
      total += amount;
      if (ts >= dayStart) today += amount;
      if (ts >= weekStart) week += amount;
      if (ts >= monthStart) month += amount;
      if (ts.getFullYear() === currentYear) {
        yearTotal += amount;
        monthly[ts.getMonth()] += amount;
      }

      // Rolling week/day buckets. Round (not floor) the day distance so a DST
      // hour shift can't push a sale into the neighboring bucket.
      const tsDayStart = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
      const daysAgo = Math.round((dayStart.getTime() - tsDayStart.getTime()) / DAY_MS);
      if (daysAgo >= 0 && daysAgo < DAYS_SHOWN) {
        daily[DAYS_SHOWN - 1 - daysAgo] += amount;
      }
      const weeksAgo = Math.round(
        (weekStart.getTime() - startOfWeek(ts).getTime()) / (7 * DAY_MS),
      );
      if (weeksAgo >= 0 && weeksAgo < WEEKS_SHOWN) {
        weekly[WEEKS_SHOWN - 1 - weeksAgo] += amount;
      }
    }

    const count = incoming.length;
    const average = count > 0
      ? Number(formatAmountFromPlanck(total, PUSD_DECIMALS)) / count
      : 0;

    return {
      count,
      today,
      week,
      month,
      average,
      yearTotal,
      monthly,
      weekly,
      daily,
    };
  }, [sales, currentYear]);

  // Chart series for the active view: values, labels, which bar is "now",
  // and the total shown above the chart.
  const chart = useMemo(() => {
    const now = new Date();
    if (view === "weeks") {
      const start = startOfWeek(now);
      const labels = stats.weekly.map((_, i) => {
        const d = new Date(start.getTime() - (WEEKS_SHOWN - 1 - i) * 7 * DAY_MS);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      });
      return {
        values: stats.weekly,
        labels,
        highlightIndex: WEEKS_SHOWN - 1,
        title: `Last ${WEEKS_SHOWN} weeks`,
        total: stats.weekly.reduce((sum, v) => sum + v, 0n),
      };
    }
    if (view === "days") {
      const labels = stats.daily.map((_, i) => {
        const d = new Date(now.getTime() - (DAYS_SHOWN - 1 - i) * DAY_MS);
        return `${d.getDate()}`;
      });
      return {
        values: stats.daily,
        labels,
        highlightIndex: DAYS_SHOWN - 1,
        title: `Last ${DAYS_SHOWN} days`,
        total: stats.daily.reduce((sum, v) => sum + v, 0n),
      };
    }
    return {
      values: stats.monthly,
      labels: MONTH_LABELS,
      highlightIndex: now.getMonth(),
      title: `Total for ${currentYear}`,
      total: stats.yearTotal,
    };
  }, [view, stats, currentYear]);

  const maxValue = chart.values.reduce((max, v) => (v > max ? v : max), 0n);
  const dim = isLoading ? "opacity-50" : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader title="Sales" onBack={() => router.back()} backLabel="Back to home" />

        <main className={`flex flex-col gap-3 px-4 pb-6 ${dim}`}>
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-3">
            {/* Transactions — links to the full list in History */}
            <Link
              href="/history"
              className="bg-surface-container rounded-container shadow-1 p-4 hover:bg-selection-container-hover transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="flex items-center gap-2 text-body-m text-fg-secondary">
                  <span className="size-2 rounded-full bg-status-success" aria-hidden />
                  Transactions
                </span>
                <ChevronRight className="size-4 text-fg-tertiary" aria-hidden />
              </div>
              <p data-testid="sales-transactions" className="text-display-l font-mono text-fg-primary">
                {stats.count}
              </p>
            </Link>

            {/* Refunds — always 0 until refunds exist in the system */}
            <div className="bg-surface-container rounded-container shadow-1 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="size-2 rounded-full bg-status-warning" aria-hidden />
                <span className="text-body-m text-fg-secondary">Refunds</span>
              </div>
              <p className="text-display-l font-mono text-fg-primary">0</p>
            </div>

            <StatCard label="Today" value={money(stats.today)} unit={symbol} />
            <StatCard label="This week" value={money(stats.week)} unit={symbol} />
            <StatCard label="This month" value={money(stats.month)} unit={symbol} />
            <StatCard
              label="Average sale"
              value={stats.average.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              unit={symbol}
            />
          </div>

          {/* Chart card — total + bars at monthly/weekly/daily granularity */}
          <div className="bg-surface-container rounded-container shadow-1 p-4">
            <p className="text-body-m text-fg-secondary mb-1">{chart.title}</p>
            <p data-testid="sales-year-total" className="mb-4 flex items-baseline gap-2">
              <span className="text-display-l font-mono text-fg-primary">{money(chart.total)}</span>
              <span className="text-label-m text-fg-secondary">{symbol}</span>
            </p>

            {/* Granularity — tabs with a line indicator, never a filled tray */}
            <Tabs
              value={view}
              onValueChange={(next) => {
                setView(next as ChartView);
                setActiveBar(null);
              }}
              className="mb-5"
            >
              <TabsList variant="line">
                <TabsTrigger value="months">Months</TabsTrigger>
                <TabsTrigger value="weeks">Weeks</TabsTrigger>
                <TabsTrigger value="days">Days</TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Bars — flat dash for empty buckets, the current bucket in the
                dark illustration fill, the rest muted */}
            <div
              className="grid gap-1.5 items-end h-28"
              style={{ gridTemplateColumns: `repeat(${chart.values.length}, minmax(0, 1fr))` }}
            >
              {chart.values.map((value, i) => {
                const ratio = maxValue > 0n
                  ? Number((value * 1000n) / maxValue) / 1000
                  : 0;
                const height = value > 0n ? Math.max(10, Math.round(ratio * 100)) : 4;
                return (
                  <button
                    type="button"
                    key={i}
                    aria-label={`${chart.labels[i]}: ${money(value)} ${symbol}`}
                    aria-pressed={activeBar === i}
                    className="group relative flex flex-col items-center justify-end h-full cursor-pointer"
                    onClick={() => setActiveBar(activeBar === i ? null : i)}
                  >
                    {/* Amount tooltip — on hover (mouse) or tap (touch); sits
                        on the inverted surface like every tooltip */}
                    <span
                      className={`pointer-events-none absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10 rounded-small bg-surface-container-inverted px-2 py-1 text-label-s font-mono text-fg-primary-inverted whitespace-nowrap shadow-2 ${
                        activeBar === i ? "" : "hidden group-hover:block"
                      }`}
                    >
                      {money(value)} {symbol}
                    </span>
                    <span
                      className={`w-full rounded-small transition-colors ${
                        i === chart.highlightIndex
                          ? "bg-illustration-dark"
                          : "bg-illustration-dark-muted group-hover:bg-illustration-dark"
                      }`}
                      style={{ height: `${height}%` }}
                    />
                  </button>
                );
              })}
            </div>
            <div
              className="grid gap-1.5 mt-2"
              style={{ gridTemplateColumns: `repeat(${chart.values.length}, minmax(0, 1fr))` }}
            >
              {chart.labels.map((label, i) => (
                <span
                  key={`${label}-${i}`}
                  className={`text-overline text-center truncate ${
                    i === chart.highlightIndex ? "text-fg-primary" : "text-fg-tertiary"
                  }`}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-surface-container rounded-container shadow-1 p-4">
      <p className="text-body-m text-fg-secondary mb-2">{label}</p>
      <p className="flex items-baseline gap-1.5">
        <span className="text-display-l font-mono text-fg-primary">{value}</span>
        <span className="text-label-s text-fg-secondary">{unit}</span>
      </p>
    </div>
  );
}
