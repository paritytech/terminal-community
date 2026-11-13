"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, ChevronRight, CircleAlert, FileCheck, FileX, History, Loader2 } from "lucide-react";
import { useReportJob } from "@/lib/components/report-job-provider";
import { useCurrentPeriod } from "@/lib/hooks/use-current-period";
import { ReportRow } from "@/components/report-row";

/**
 * Reports (Home → Reports, merchant-only): save the current period as an
 * X-report or close the day with a Z-report, on top of the existing
 * background report pipeline. History preview + Recover Reports below.
 */

type Tab = "current" | "summary";

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("current");
  const [confirmClose, setConfirmClose] = useState(false);
  const { currentPeriod, reports, transactionCount } = useCurrentPeriod();
  const { runSavePeriod, runFinalizePeriod, isRunning, phaseLabel, error } = useReportJob();

  const canRun = Boolean(currentPeriod) && transactionCount > 0 && !isRunning;
  const recent = reports.slice(0, 2);

  const handleSaveCurrent = () => {
    if (!currentPeriod || !canRun) return;
    void runSavePeriod(currentPeriod);
  };

  const handleCloseDay = () => {
    if (!currentPeriod || !canRun) return;
    setConfirmClose(false);
    void runFinalizePeriod(currentPeriod);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4 shrink-0">
          <Link href="/home" className="p-2" aria-label="Back to home">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <span className="text-white text-lg font-semibold">Reports</span>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {/* X / Z toggle */}
          <div className="flex bg-neutral-900 rounded-xl p-1 mb-4">
            {([
              ["current", "Current report"],
              ["summary", "Day summary"],
            ] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                  tab === key ? "bg-white text-black" : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Action card */}
          <div className="bg-neutral-900 rounded-2xl p-5 mb-8">
            <div className="flex items-start gap-4 mb-5">
              <span
                className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${
                  tab === "summary" ? "bg-[#4353ff]" : "bg-neutral-800"
                }`}
              >
                {tab === "summary" ? (
                  <FileCheck className="w-6 h-6 text-white" />
                ) : (
                  <FileX className="w-6 h-6 text-white" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-neutral-400 text-sm">
                  {tab === "summary" ? "Z-Report" : "X-Report"}
                </p>
                <h2 className="text-white text-2xl font-bold leading-tight">
                  {tab === "summary" ? "Day summary" : "Current report"}
                </h2>
                <p className="text-neutral-400 text-sm mt-1">
                  {tab === "summary"
                    ? `Ends the day and saves a summary of ${transactionCount} transactions`
                    : `Saves the current ${transactionCount} transactions`}
                </p>
              </div>
            </div>

            {error && (
              <p data-testid="report-error" className="text-red-400 text-xs mb-3">{error}</p>
            )}

            <button
              type="button"
              onClick={tab === "summary" ? () => setConfirmClose(true) : handleSaveCurrent}
              disabled={!canRun}
              className="w-full bg-white hover:bg-neutral-100 disabled:bg-neutral-800 disabled:text-neutral-500 text-black font-semibold py-4 rounded-xl transition flex items-center justify-center gap-2"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {phaseLabel || "Working…"}
                </>
              ) : transactionCount === 0 ? (
                "No transactions yet"
              ) : tab === "summary" ? (
                "Save Report & Close the Day"
              ) : (
                "Save Current Report"
              )}
            </button>
          </div>

          {/* Report history preview */}
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-white font-semibold">Report History</h3>
            <Link
              href="/home/reports/history"
              className="flex items-center gap-1 text-neutral-400 hover:text-white text-sm transition"
            >
              See all <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
          {recent.length > 0 ? (
            <div className="bg-neutral-900 rounded-2xl px-4 py-1.5 mb-8">
              {recent.map((record) => (
                <ReportRow key={record.date} record={record} />
              ))}
            </div>
          ) : (
            <p className="text-neutral-500 text-sm mb-8">No reports yet.</p>
          )}

          {/* Additional features */}
          <h3 className="text-white font-semibold mb-2">Additional features</h3>
          <div className="space-y-3">
            {/* Placeholder — reminder scheduling isn't built yet. */}
            <button
              type="button"
              className="w-full flex items-center gap-3 bg-neutral-900 hover:bg-neutral-800 rounded-2xl px-4 py-4 transition"
            >
              <Bell className="w-5 h-5 text-white shrink-0" />
              <span className="flex-1 text-white font-medium text-left">Daily Close Reminder</span>
              <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
            </button>
            <Link
              href="/home/reports/recover"
              className="w-full flex items-center gap-3 bg-neutral-900 hover:bg-neutral-800 rounded-2xl px-4 py-4 transition"
            >
              <History className="w-5 h-5 text-white shrink-0" />
              <span className="flex-1 text-white font-medium text-left">Recover Reports</span>
              <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
            </Link>
          </div>
        </main>
      </div>

      {/* Close-the-day confirmation sheet */}
      {confirmClose && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <button
            aria-label="Dismiss"
            onClick={() => setConfirmClose(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div className="relative bg-neutral-900 rounded-t-3xl px-6 pt-8 pb-6 max-w-md mx-auto w-full">
            <div className="flex justify-center mb-5">
              <span className="w-14 h-14 rounded-full bg-amber-400 flex items-center justify-center">
                <CircleAlert className="w-7 h-7 text-black" />
              </span>
            </div>
            <h2 className="text-white text-2xl font-bold text-center leading-snug mb-2">
              Do you want to save the report and close the day?
            </h2>
            <p className="text-neutral-400 text-sm text-center mb-6">
              This finalizes today&apos;s sales and can&apos;t be undone. You won&apos;t be
              able to add anything to this day afterward.
            </p>
            <button
              onClick={handleCloseDay}
              className="w-full bg-white hover:bg-neutral-100 text-black font-semibold py-4 rounded-2xl transition mb-3"
            >
              Proceed
            </button>
            <button
              onClick={() => setConfirmClose(false)}
              className="w-full bg-neutral-800 hover:bg-neutral-700 text-white font-semibold py-4 rounded-2xl transition"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
