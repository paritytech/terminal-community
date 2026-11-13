"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CloudDownload, Search } from "lucide-react";
import { getMerchantTerminal } from "@/lib/contracts/revive-bulletin-index";
import { restoreReportsFromChain } from "@/lib/bulletin/restore-reports";
import { useCurrentPeriod } from "@/lib/hooks/use-current-period";
import { ReportRow, reportDayKey, reportGroupLabel } from "@/components/report-row";
import { captureError } from "@/lib/telemetry";
import type { DailyReportRecord } from "@/lib/storage/types";

/**
 * Recover Reports: pull backed-up reports from the chain into local storage.
 * Idle → tap the cloud icon → skeleton loading → restored list + toast, or
 * the "nothing in backup" empty state. Restored records land in the same
 * store the history reads, so everything below stays live.
 */

type RecoverState = "idle" | "loading" | "done" | "empty" | "error";

export default function RecoverReportsPage() {
  const { reports } = useCurrentPeriod();
  const [state, setState] = useState<RecoverState>("idle");
  const [restoredCount, setRestoredCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");

  const handleRecover = async () => {
    if (state === "loading") return;
    setState("loading");
    setError(null);
    try {
      const { merchantId, terminalId } = await getMerchantTerminal();
      const result = await restoreReportsFromChain(merchantId, terminalId);
      setRestoredCount(result.restored);
      setState(result.total === 0 ? "empty" : "done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
      setState("error");
      captureError(err, { component: "recover-reports", phase: "restore" });
    }
  };

  const groups = useMemo(() => {
    const query = term.trim().toLowerCase();
    const filtered = query
      ? reports.filter((r) =>
          `${r.finalized ? "day summary z-report" : "current report x-report"} ${r.date}`
            .toLowerCase()
            .includes(query),
        )
      : reports;
    const byDay = new Map<string, DailyReportRecord[]>();
    for (const record of filtered) {
      const key = reportDayKey(record);
      byDay.set(key, [...(byDay.get(key) ?? []), record]);
    }
    return [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [reports, term]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header — the cloud icon runs the recovery */}
        <header className="flex items-center justify-between px-4 py-4 shrink-0">
          <Link href="/home/reports" className="p-2" aria-label="Back to reports">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <span className="text-white text-lg font-semibold">Recover Reports</span>
          <button
            onClick={handleRecover}
            className="p-2"
            aria-label="Pull reports from backup"
          >
            {state === "loading" ? (
              <span className="block w-6 h-6 rounded-full border-2 border-neutral-700 border-t-white animate-spin" />
            ) : (
              <CloudDownload className="w-6 h-6 text-white" />
            )}
          </button>
        </header>

        {/* Search */}
        <div className="px-6 pb-3 shrink-0">
          <div className="flex items-center gap-2 bg-neutral-900 rounded-full px-4 py-2.5">
            <Search className="w-4 h-4 text-neutral-500 shrink-0" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search reports"
              className="w-full bg-transparent text-white text-sm outline-none placeholder:text-neutral-500"
            />
          </div>
        </div>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col">
          {state === "loading" ? (
            /* Skeletons under a group-header placeholder while the chain is read */
            <div className="pt-2">
              <span className="block w-16 h-2.5 rounded bg-neutral-800 mb-3" />
              <div className="space-y-3">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="rounded-2xl bg-neutral-900 p-4 space-y-2 animate-pulse">
                    <span className="block w-2/3 h-2.5 rounded bg-neutral-800" />
                    <span className="block w-1/3 h-2.5 rounded bg-neutral-800" />
                  </div>
                ))}
              </div>
            </div>
          ) : state === "idle" && reports.length === 0 ? (
            <EmptyIllustration
              caption={
                <>
                  Tap <CloudDownload className="inline w-4 h-4 -mt-0.5" /> to pull your
                  saved reports from backup
                </>
              }
            />
          ) : state === "empty" && reports.length === 0 ? (
            <EmptyIllustration caption="We couldn't find any saved reports in your backup" />
          ) : (
            <>
              {groups.map(([day, records]) => (
                <section key={day} className="mb-4">
                  <h3 className="text-neutral-400 text-xs font-semibold tracking-widest mb-1">
                    {reportGroupLabel(day)}
                  </h3>
                  {records.map((record) => (
                    <ReportRow key={record.date} record={record} />
                  ))}
                </section>
              ))}
              {state === "error" && (
                <p data-testid="report-error" className="text-red-400 text-sm text-center py-4">{error}</p>
              )}
            </>
          )}

          {/* Success toast */}
          {state === "done" && (
            <div className="sticky bottom-2 mt-auto flex justify-center">
              <div className="flex items-center gap-2 bg-neutral-800 border border-neutral-700 text-white text-sm font-medium px-5 py-3 rounded-full shadow-xl">
                <Check className="w-4 h-4" />
                Restored {restoredCount} report{restoredCount === 1 ? "" : "s"} successfully
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyIllustration({ caption }: { caption: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center">
      <div className="relative w-40 h-24 mb-6" aria-hidden>
        <div className="absolute inset-x-6 top-0 h-14 rounded-xl bg-neutral-900 rotate-[-4deg] p-3 space-y-2">
          <span className="block w-2/3 h-2 rounded bg-neutral-700" />
          <span className="block w-1/3 h-2 rounded bg-neutral-800" />
        </div>
        <div className="absolute inset-x-2 top-8 h-14 rounded-xl bg-neutral-950 border border-neutral-900 rotate-[3deg] p-3 space-y-2">
          <span className="block w-1/2 h-2 rounded bg-neutral-800" />
        </div>
      </div>
      <p className="text-neutral-500 text-sm max-w-xs">{caption}</p>
    </div>
  );
}
