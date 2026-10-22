"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, FileDown, Loader2, Download } from "lucide-react";
import { useAccount } from "@/lib/web3";
import { useAdminQrPayload } from "@/lib/config/admin-qr-binding";
import { useBulletin } from "@/lib/hooks/use-bulletin";
import { captureError } from "@/lib/telemetry";
import { saveFile } from "@/lib/utils/save-file";
import {
  type ExportRow,
  buildCsv,
  enumerateDateRange,
  fetchExportRowsForDate,
  formatYmd,
  todayString,
} from "@/lib/export/csv";

export default function ExportPage() {
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  const { readDailyReport } = useBulletin();
  const merchantIdentity = adminPayload?.receivingAddress ?? account?.address;
  const today = todayString();
  const [exportRange, setExportRange] = useState<"today" | "last-3" | "custom">("today");
  const [exportFrom, setExportFrom] = useState(today);
  const [exportTo, setExportTo] = useState(today);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Gate host-dependent UI until after mount so the static-export prerender
  // matches the first client render — avoids hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const computeExportDates = (): string[] => {
    if (exportRange === "today") return [todayString()];
    if (exportRange === "last-3") {
      return [2, 1, 0].map((daysAgo) => {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        return formatYmd(d);
      });
    }
    return enumerateDateRange(exportFrom, exportTo);
  };

  const handleRunExport = async () => {
    setExportRunning(true);
    setExportError(null);
    try {
      if (!merchantIdentity) throw new Error("Merchant account is not available");
      const dates = computeExportDates();
      if (dates.length === 0) throw new Error("Choose a valid date range");
      if (dates.length > 92) throw new Error("Choose 92 days or fewer");

      const rows: ExportRow[] = [];
      for (const date of dates) {
        rows.push(...await fetchExportRowsForDate(date, merchantIdentity, readDailyReport));
      }
      if (rows.length === 0) throw new Error("No sales found for the selected dates");

      const label = dates.length === 1 ? dates[0] : `${dates[0]}_${dates.at(-1)}`;
      const csv = buildCsv(rows);
      await saveFile(`t3rminal-sales-${label}.csv`, new Blob([csv], { type: "text/csv" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      setExportError(msg);
      captureError(err, { component: "export", phase: "export" });
    } finally {
      setExportRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/settings" className="p-2">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <div className="flex items-center gap-2">
            <FileDown className="w-5 h-5 text-white" />
            <span className="text-white font-medium">Export sales (CSV)</span>
          </div>
          <div className="w-10" />
        </header>

        {mounted && !merchantIdentity && (
          <div className="px-6 py-2">
            <div className="bg-yellow-900/30 border border-yellow-800 rounded-lg p-3 text-yellow-400 text-sm">
              Export is unavailable until a merchant account is configured.
            </div>
          </div>
        )}

        <main className="flex-1 min-h-0 px-6 py-4 space-y-4 overflow-auto">
          <p className="text-xs text-neutral-400">
            Exports sales for the selected dates as a CSV file. Saved reports are
            used where available, falling back to local sales.
          </p>

          <div className="grid grid-cols-3 gap-2">
            {(["today", "last-3", "custom"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setExportRange(opt)}
                className={`py-2 px-3 rounded-lg text-xs font-medium transition ${
                  exportRange === opt
                    ? "bg-white text-black"
                    : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                }`}
              >
                {opt === "today" ? "Today" : opt === "last-3" ? "Last 3 days" : "Custom"}
              </button>
            ))}
          </div>

          {exportRange === "custom" && (
            <div className="space-y-2">
              <label className="block text-xs text-neutral-500">
                From
                <input
                  type="date"
                  value={exportFrom}
                  max={exportTo}
                  onChange={(e) => setExportFrom(e.target.value)}
                  className="w-full mt-1 bg-neutral-800 text-white rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-neutral-600"
                />
              </label>
              <label className="block text-xs text-neutral-500">
                To
                <input
                  type="date"
                  value={exportTo}
                  min={exportFrom}
                  max={todayString()}
                  onChange={(e) => setExportTo(e.target.value)}
                  className="w-full mt-1 bg-neutral-800 text-white rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-neutral-600"
                />
              </label>
              <p className="text-[10px] text-neutral-600">Up to 92 days per export.</p>
            </div>
          )}

          {exportError && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-2 text-red-400 text-xs">
              {exportError}
            </div>
          )}

          <button
            type="button"
            onClick={handleRunExport}
            disabled={!merchantIdentity || exportRunning}
            className="w-full bg-white text-black py-3 rounded-xl font-medium flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {exportRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Exporting…
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Export
              </>
            )}
          </button>
        </main>
      </div>

    </div>
  );
}
