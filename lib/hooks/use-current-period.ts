"use client";

/**
 * Live view of today's open report period — the same period math the legacy
 * daily-reports page uses, extracted for the Reports screens: today's sales
 * after the last finalized (Z) report form the current period; the period key
 * gets a `#NN` suffix once a day contains multiple periods.
 */

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/web3";
import { normalizeToAssetHubAddress } from "@/lib/utils/address";
import { getAllDailyReports, getSalesForMerchantByDate } from "@/lib/storage/database";
import { onStorageChange } from "@/lib/storage/host-storage";
import type { DailyReportRecord, SaleRecord } from "@/lib/storage/types";
import type { PeriodReportArgs } from "@/lib/hooks/use-daily-report";

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function useCurrentPeriod() {
  const { account } = useAccount();
  const merchantIdentity = account?.address ?? null;

  const [reports, setReports] = useState<DailyReportRecord[]>([]);
  const [todaySales, setTodaySales] = useState<SaleRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = () =>
      getAllDailyReports()
        .then((r) => setReports(r))
        // The storage banner says why; stop loading. A recovery refetches.
        .catch((err) => console.warn("[CurrentPeriod] reports unreadable:", err))
        .finally(() => setIsLoading(false));
    void load();
    return onStorageChange("dailyReports", () => void load());
  }, []);

  useEffect(() => {
    if (!merchantIdentity) {
      setTodaySales([]);
      return;
    }
    const merchant = normalizeToAssetHubAddress(merchantIdentity);
    const load = () => {
      const today = todayString();
      const dayStart = new Date(today + "T00:00:00");
      const dayEnd = new Date(today + "T23:59:59.999");
      void getSalesForMerchantByDate(merchant, dayStart, dayEnd)
        .then(setTodaySales)
        .catch((err) => console.warn("[CurrentPeriod] sales unreadable:", err));
    };
    load();
    return onStorageChange("sales", load);
  }, [merchantIdentity]);

  const today = todayString();
  const todayReports = reports.filter((r) => r.date === today || r.date.startsWith(`${today}#`));
  const latestFinalizedReport = todayReports
    .filter((r) => r.finalized)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0];
  const openPeriodReport = todayReports
    .filter((r) => !r.finalized && r.date.includes("#"))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0];
  const finalizedAtSource = latestFinalizedReport?.periodClosedAt ?? latestFinalizedReport?.publishedAt;
  const finalizedAt = finalizedAtSource ? new Date(finalizedAtSource).getTime() : 0;
  const currentPeriodSales = finalizedAt > 0
    ? todaySales.filter((sale) => new Date(sale.timestamp).getTime() > finalizedAt)
    : todaySales;
  // Next period number from the highest existing suffix — a deleted or
  // out-of-order-restored report can never collide with an existing slot.
  const nextPeriodNumber = todayReports
    .map((r) => {
      const suffix = r.date.split("#")[1];
      return suffix ? Number(suffix) : 1;
    })
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((max, n) => Math.max(max, n), 0) + 1;
  const periodKey =
    openPeriodReport?.date ??
    (latestFinalizedReport ? `${today}#${String(nextPeriodNumber).padStart(2, "0")}` : today);
  const periodNumber = periodKey.includes("#") ? Number(periodKey.split("#")[1]) : 1;

  const currentPeriod: PeriodReportArgs | null = merchantIdentity
    ? {
        date: today,
        periodKey,
        merchantAddress: normalizeToAssetHubAddress(merchantIdentity),
        sales: currentPeriodSales,
        periodStart: finalizedAt > 0 ? new Date(finalizedAt) : new Date(today + "T00:00:00"),
        periodLabel: Number.isFinite(periodNumber) ? `Period ${periodNumber}` : "Current period",
      }
    : null;

  return {
    reports,
    currentPeriod,
    transactionCount: currentPeriodSales.length,
    isLoading,
  };
}
