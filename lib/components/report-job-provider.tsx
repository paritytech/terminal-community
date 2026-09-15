"use client";

/**
 * Runs save/finalize report jobs ABOVE the page tree.
 *
 * The report pipeline (generate → encrypt → upload to Bulletin → on-chain →
 * save local) is slow — the merchant should be able to start it and walk away
 * (serve a customer, switch screens) without it dying. When the work lived in
 * the Daily Reports page it was tied to that component: navigating away unmounted
 * it, the progress state was lost, and a return remounted a fresh, idle hook
 * (so it looked interrupted, and could be double-started).
 *
 * Hoisting `useDailyReport` into this provider — mounted once in the root layout
 * — keeps the in-flight promise and its state alive across navigation. A slim
 * global banner shows progress (and a transient result) from any screen.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  useDailyReport,
  type PeriodReportArgs,
  type UseDailyReportReturn,
} from "@/lib/hooks/use-daily-report";

interface ActiveJob {
  key: string;
  mode: "save" | "finalize";
  label: string;
}

interface ReportJobValue {
  /** The job currently running (null = idle). Survives navigation. */
  activeJob: ActiveJob | null;
  /** True while any report job is in flight. */
  isRunning: boolean;
  /** User-facing phase label from the pipeline. */
  phaseLabel: string;
  /** Last pipeline error, if any. */
  error: string | null;
  /** Passthrough for the print path (no job tracking needed). */
  generateReportForSales: UseDailyReportReturn["generateReportForSales"];
  /** Save (X) a period in the background. Fire-and-forget. */
  runSavePeriod: (args: PeriodReportArgs) => Promise<void>;
  /** Finalize (Z) a period in the background. Fire-and-forget. */
  runFinalizePeriod: (args: PeriodReportArgs) => Promise<void>;
}

const ReportJobContext = createContext<ReportJobValue | null>(null);

export function useReportJob(): ReportJobValue {
  const ctx = useContext(ReportJobContext);
  if (!ctx) throw new Error("useReportJob must be used within a ReportJobProvider");
  return ctx;
}

export function ReportJobProvider({ children }: { children: React.ReactNode }) {
  const report = useDailyReport();
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Auto-dismiss the completion toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (job: ActiveJob, fn: () => Promise<unknown>) => {
      // Guard against a second job while one is in flight.
      if (activeJob) return;
      setActiveJob(job);
      setToast(null);
      try {
        await fn();
        setToast({
          tone: "success",
          text: `${job.mode === "finalize" ? "Closed" : "Saved"} ${job.label}`,
        });
      } catch (err) {
        setToast({
          tone: "error",
          text: err instanceof Error ? err.message : "Report failed",
        });
      } finally {
        setActiveJob(null);
      }
    },
    [activeJob],
  );

  const runSavePeriod = useCallback(
    (args: PeriodReportArgs) =>
      run(
        { key: args.periodKey, mode: "save", label: args.periodLabel ?? args.periodKey },
        () => report.savePeriodReport(args),
      ),
    [run, report],
  );

  const runFinalizePeriod = useCallback(
    (args: PeriodReportArgs) =>
      run(
        { key: args.periodKey, mode: "finalize", label: args.periodLabel ?? args.periodKey },
        () => report.finalizePeriodReport(args),
      ),
    [run, report],
  );

  const value: ReportJobValue = {
    activeJob,
    isRunning: activeJob !== null,
    phaseLabel: report.phaseLabel,
    error: report.error,
    generateReportForSales: report.generateReportForSales,
    runSavePeriod,
    runFinalizePeriod,
  };

  return (
    <ReportJobContext.Provider value={value}>
      {children}
      {(activeJob || toast) && (
        <div className="fixed inset-x-0 top-0 z-[80] flex justify-center px-4 pt-[env(safe-area-inset-top)] pointer-events-none">
          {/* Toast: progress rides on the inverted surface (like a tooltip),
              outcomes on the theme-invariant status fills with static white
              text. Depth is shadow-2, not a border. */}
          <div
            className={`mt-2 max-w-md w-full rounded-nested px-4 py-3 text-label-m flex items-center gap-2 shadow-2 ${
              activeJob
                ? "bg-surface-container-inverted text-fg-primary-inverted"
                : toast?.tone === "success"
                  ? "bg-status-success text-fg-static-white"
                  : "bg-status-error text-fg-static-white"
            }`}
          >
            {activeJob ? (
              <>
                <Loader2 className="size-4 animate-spin shrink-0" aria-hidden />
                <span className="truncate">
                  {activeJob.mode === "finalize" ? "Closing" : "Saving"} {activeJob.label}
                  {report.phaseLabel ? ` — ${report.phaseLabel}` : "…"}
                </span>
              </>
            ) : toast?.tone === "success" ? (
              <>
                <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{toast.text}</span>
              </>
            ) : (
              <>
                <AlertCircle className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{toast?.text}</span>
              </>
            )}
          </div>
        </div>
      )}
    </ReportJobContext.Provider>
  );
}
